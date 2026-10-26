import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'node:path';
import { authenticateManagedTestPage } from './helpers/managed-test-context';
import { chatComposerInput } from './helpers/chat-composer';
import { EXTENSION_SELECTION_LIMITS } from '../app/lib/capabilities/extensions/contracts';
import { chatExtensionOptionsRequestSchema, type ChatExtensionOptionsResponse } from '../app/lib/chat/extension-options-contracts';
import type { AgentExtensionSearchItem, AgentExtensionPackageVersion } from '../app/lib/agents/extension-options-contracts';

dotenv.config({ path: process.env.CANVAS_ENV_FILE || path.join(process.cwd(), '.env.local'), quiet: true });

const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';
const AUTH_STATE_PATH = 'test-results/chat-file-reference-auth.json';
const WORKSPACE_ID_HEADER = 'x-canvas-workspace-id';
const ownedWorkspaces = new Map<Page, Array<{ id: string; name: string }>>();

async function login(page: Page) {
  await authenticateManagedTestPage(page, { email: TEST_EMAIL, password: TEST_PASSWORD });
  await page.goto('/notebook?chat=open', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/notebook\?chat=open$/, { timeout: 15000 });
}

async function startFreshChat(page: Page) {
  await page.getByRole('button', { name: /new chat/i }).click();
  await expect(page.getByTestId('chat-session-id')).toHaveCount(0);
  await expect(chatComposerInput(page)).toBeVisible();
}

async function getActiveWorkspaceId(page: Page): Promise<string> {
  await page.waitForFunction(() => Boolean(window.localStorage.getItem('canvas.activeWorkspaceId')));
  const workspaceId = await page.evaluate(() => window.localStorage.getItem('canvas.activeWorkspaceId'));
  expect(workspaceId).toBeTruthy();
  return workspaceId as string;
}

async function createWorkspace(page: Page, name: string): Promise<string> {
  const response = await page.request.post('/api/workspaces', { data: { name, type: 'personal' } });
  const payload = await response.json() as { workspace?: { id: string; name: string; type: string; permissions: { canManageWorkspace: boolean } }; error?: string };
  if (response.ok() && payload.workspace?.name === name && payload.workspace.type === 'personal'
    && payload.workspace.permissions.canManageWorkspace) {
    ownedWorkspaces.set(page, [...(ownedWorkspaces.get(page) ?? []), { id: payload.workspace.id, name }]);
  }
  expect(response.ok(), payload.error || 'Failed to create test workspace').toBeTruthy();
  expect(payload.workspace?.id).toBeTruthy();
  return payload.workspace!.id!;
}

async function switchWorkspace(page: Page, workspaceId: string) {
  await page.evaluate((id) => window.localStorage.setItem('canvas.activeWorkspaceId', id), workspaceId);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem('canvas.activeWorkspaceId'))).toBe(workspaceId);
}

async function createDirectory(page: Page, workspaceId: string, directoryPath: string) {
  const response = await page.request.post('/api/files/create', {
    headers: { [WORKSPACE_ID_HEADER]: workspaceId },
    data: { path: directoryPath, type: 'directory' },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function writeWorkspaceFile(page: Page, workspaceId: string, filePath: string, content: string) {
  const response = await page.request.post('/api/files/write', {
    headers: { [WORKSPACE_ID_HEADER]: workspaceId },
    data: { path: filePath, content },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function mockSkills(page: Page, enabled: boolean, includePlugin = false) {
  // Metadata-only UI fixture. Real session, workspace files and all send-time
  // authority checks stay on the managed server; this fixture never sends.
  const rows: AgentExtensionSearchItem[] = [];
  const packages = new Map<string, AgentExtensionPackageVersion>();
  for (const kind of ['skill', 'plugin'] as const) {
    if (!enabled || kind === 'plugin' && !includePlugin) continue;
    const name = kind === 'skill' ? 'pdf' : 'reference-test-plugin';
    const suffix = kind === 'skill' ? '1' : '2';
    const pin = { resourceRef: `canvas-resource:10000000-0000-4000-8000-00000000000${suffix}`,
      publishedRevisionRef: `canvas-package-revision:20000000-0000-4000-8000-00000000000${suffix}`, checksum: 'a'.repeat(64) };
    packages.set(pin.resourceRef, { pin, kind, name, displayName: name, version: '1.0.0', description: 'Reference picker metadata fixture',
      children: kind === 'skill' ? [{ name, description: 'PDF fixture', relativeRoot: '', origin: 'standalone', required: true }] : [], declarations: [] });
    rows.push({ item: { id: `metadata-fixture:${name}`, kind, name, displayName: name,
      description: 'Reference picker metadata fixture', source: 'local', stock: 'installed',
      access: { canRead: true, canUse: true, canManage: false } }, eligibility: { action: 'select' }, chatAvailability: 'ready',
      selection: kind === 'skill' ? { kind: 'skill', package: pin, origin: 'standalone', relativeRoot: '' }
        : { kind: 'plugin', package: pin, skillSelection: { kind: 'all' } } });
  }
  await page.route('**/api/chat/extension-options', async route => {
    const request = chatExtensionOptionsRequestSchema.parse(route.request().postDataJSON());
    const header = { schemaVersion: 1 as const, target: request.target, contextKey: JSON.stringify(request.target),
      coverage: [], limits: EXTENSION_SELECTION_LIMITS, agentRevision: 1, workflowRevision: 0,
      preferenceRevision: 0, finalSendValidationRequired: true as const };
    let data: ChatExtensionOptionsResponse;
    if (request.operation === 'search') {
      const items = request.phase === 'remote' ? [] : rows.filter(row => request.types.includes(row.item.kind)
        && row.item.name.includes(request.q.toLowerCase()));
      data = { ...header, operation: 'search', query: request, items, selectedItem: null,
        scopes: { choices: ['all'], teams: [] }, recents: [],
        pagination: { nextCursor: null, hasNextPage: false, loadedItems: items.length } };
    } else if (request.operation === 'package_version') {
      const metadata = packages.get(request.resourceRef);
      expect(metadata?.pin.publishedRevisionRef).toBe(request.publishedRevisionRef);
      expect(metadata?.pin.checksum).toBe(request.checksum);
      if (!metadata) throw new Error('Unknown reference metadata fixture.');
      data = { ...header, operation: 'package_version', package: metadata };
    } else if (request.operation === 'preview') {
      data = { ...header, operation: 'preview', preview: { configurationReadiness: 'unknown', contextValidation: 'unknown',
        personalSetupRequired: false, runtimeReadiness: 'not_checked', providerHealth: 'unknown',
        finalSendValidationRequired: true, budget: null, issues: [], requirements: [], effectiveToolCaps: [], toolConflicts: [] } };
    } else if (request.operation === 'presentation') {
      data = { ...header, operation: 'presentation', entries: request.selections.map(selection => ({ selection })) };
    } else {
      throw new Error(`Unexpected metadata-only reference request: ${request.operation}`);
    }
    await route.fulfill({ json: { success: true, data } });
  });
}

async function selectedReferenceIsInsidePicker(picker: Locator) {
  return picker.evaluate((element) => {
    const selectedItem = element.querySelector<HTMLElement>('[data-active="true"]');
    if (!selectedItem) return false;

    const selectedTop = selectedItem.offsetTop;
    const selectedBottom = selectedTop + selectedItem.offsetHeight;
    return selectedTop >= element.scrollTop && selectedBottom <= element.scrollTop + element.clientHeight;
  });
}

test.describe('Chat File Reference Picker', () => {
  test.setTimeout(90000);
  test.use({ storageState: AUTH_STATE_PATH });

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    test.setTimeout(120000);
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    await login(page);
    await context.storageState({ path: AUTH_STATE_PATH });
    await context.close();
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/notebook?chat=open');
    const workspaceId = await createWorkspace(page, `Reference picker ${crypto.randomUUID()}`);
    await switchWorkspace(page, workspaceId);
  });

  test.afterEach(async ({ page }) => {
    const request = page.request;
    await page.close();
    const errors: unknown[] = [];
    for (const owned of ownedWorkspaces.get(page) ?? []) {
      try {
        const response = await request.get('/api/workspaces', { timeout: 15_000 });
        expect(response.status()).toBe(200);
        const payload = await response.json();
        expect(payload.workspaces.find((workspace: { id: string }) => workspace.id === owned.id)).toMatchObject({
          id: owned.id, name: owned.name, type: 'personal', permissions: { canManageWorkspace: true },
        });
        const deleted = await request.delete(`/api/workspaces/${encodeURIComponent(owned.id)}`, { timeout: 15_000 });
        expect(deleted.status(), 'Remove only the exact test-owned workspace after closing its page.').toBe(200);
      } catch (error) { errors.push(error); }
    }
    ownedWorkspaces.delete(page);
    if (errors.length) throw new AggregateError(errors, 'Owned reference-picker workspace cleanup failed.');
  });

  test('searches the selected workspace and prefers direct filename matches', async ({ page }) => {
    await page.goto('/notebook?chat=open');
    const fixtureId = `playwright-file-picker-${Date.now()}`;
    const query = `PickerUnique${Date.now()}`;
    const workspaceId = await createWorkspace(page, `Reference Picker ${Date.now()}`);
    await switchWorkspace(page, workspaceId);
    const pathOnlyDir = `${fixtureId}/${query}`;
    const filenameDir = `${fixtureId}/Elsewhere`;
    await createDirectory(page, workspaceId, pathOnlyDir);
    await createDirectory(page, workspaceId, filenameDir);
    await writeWorkspaceFile(page, workspaceId, `${pathOnlyDir}/unrelated-notes.md`, '# Path-only match\n');
    await writeWorkspaceFile(page, workspaceId, `${filenameDir}/${query}.md`, '# Filename match\n');

    try {
      await startFreshChat(page);

      const input = chatComposerInput(page);
      const searchRequest = page.waitForRequest((request) => request.url().includes('/api/files/list'));
      await input.fill(`@${query}`);
      const request = await searchRequest;
      expect(new URL(request.url()).searchParams.get('workspaceId')).toBe(workspaceId);
      expect(request.headers()[WORKSPACE_ID_HEADER]).toBe(workspaceId);

      const picker = page.getByTestId('chat-reference-picker');
      await expect(picker.getByTestId('chat-reference-item').first()).toContainText(`${fixtureId}/Elsewhere/${query}`, { timeout: 15000 });
      await expect(picker.getByTestId('chat-reference-item').first()).not.toContainText(`/${query}/unrelated-notes.md`);
    } finally {
      // The verified workspace creation receipts are cleaned up in afterEach.
    }
  });

  test('reference button combines current workspace files, plugins, and skills', async ({ page }) => {
    await mockSkills(page, true, true);
    await page.goto('/notebook?chat=open');
    const workspaceId = await getActiveWorkspaceId(page);
    const fixtureId = `000-plus-reference-${Date.now()}`;
    await createDirectory(page, workspaceId, fixtureId);
    await writeWorkspaceFile(page, workspaceId, `${fixtureId}/plus-context.md`, '# Plus context\n');

    try {
      await startFreshChat(page);
      const input = chatComposerInput(page);
      await page.getByRole('button', { name: /Insert plugins, skills and connections|Plugins, Skills und Verbindungen einfügen/i }).click();
      const picker = page.getByTestId('chat-reference-picker');
      await expect(picker.locator('[data-reference-kind="file"]')).not.toHaveCount(0, { timeout: 15000 });
      await expect(picker.locator('[data-reference-kind="plugin"]')).toHaveCount(1);
      await expect(picker.locator('[data-reference-kind="skill"]')).not.toHaveCount(0);

      await picker.locator('[data-reference-kind="plugin"]').click();
      const inserted = input.locator('[data-type="extension-reference"]');
      await expect(inserted).toHaveCount(1);
      await expect(inserted.getByText('reference-test-plugin', { exact: true })).toBeVisible();
    } finally {
      // afterEach closes this page and its metadata routes before owned cleanup.
    }
  });

  test('shows active skill references and inserts the selected skill', async ({ page }) => {
    await mockSkills(page, true);
    await page.goto('/notebook?chat=open');

    await startFreshChat(page);

    const input = chatComposerInput(page);
    await input.fill('@pdf');

    const picker = page.getByTestId('chat-reference-picker');
    await expect(picker).toBeVisible({ timeout: 15000 });
    await expect(picker).toContainText(/pdf/i);
    await expect(picker.locator('[data-reference-kind="skill"]')).toContainText('pdf');
    await expect(picker.locator('[data-reference-kind="skill"] [data-testid="chat-reference-icon"]').first()).toBeVisible();

    await input.press('Enter');
    const inserted = input.locator('[data-type="extension-reference"]');
    await expect(inserted).toHaveCount(1);
    await expect(inserted.getByText('pdf', { exact: true })).toBeVisible();
    await expect(picker).toBeHidden();
  });

  test('does not show disabled skills in the reference picker', async ({ page }) => {
    await mockSkills(page, false);
    await page.goto('/notebook?chat=open');

    try {
      await startFreshChat(page);

      const input = chatComposerInput(page);
      await input.fill('@pdf');

      const picker = page.getByTestId('chat-reference-picker');
      await expect(picker).toBeVisible({ timeout: 15000 });
      await expect(picker.locator('[data-reference-kind="skill"]')).toHaveCount(0);
      await expect(picker).toContainText(/No files, plugins, or skills found matching|Keine Dateien, Plugins oder Skills gefunden/);
      await expect(picker).not.toContainText('/pdf');
    } finally {
      // afterEach closes this page and its metadata routes before owned cleanup.
    }
  });

  test('does not open the slash picker inside normal paths or URLs', async ({ page }) => {
    await page.goto('/notebook?chat=open');
    await startFreshChat(page);

    const input = chatComposerInput(page);
    const picker = page.getByTestId('chat-reference-picker');

    await input.fill('foo/bar');
    await expect(picker).toHaveCount(0);

    await input.fill('https://example.com');
    await expect(picker).toHaveCount(0);
  });

  test('keeps the selected reference visible while navigating with arrow keys', async ({ page }) => {
    const fixtureId = `playwright-file-picker-scroll-${Date.now()}`;
    const query = `PickerScrollUnique${Date.now()}`;
    await page.goto('/notebook?chat=open');
    const workspaceId = await getActiveWorkspaceId(page);
    await createDirectory(page, workspaceId, fixtureId);
    for (let index = 0; index < 12; index += 1) {
      const paddedIndex = String(index).padStart(2, '0');
      await writeWorkspaceFile(page, workspaceId, `${fixtureId}/${query}-${paddedIndex}.md`, `# ${query} ${paddedIndex}\n`);
    }

    try {
      await startFreshChat(page);

      const input = chatComposerInput(page);
      await input.fill(`@${query}`);

      const picker = page.getByTestId('chat-reference-picker');
      await expect(picker).toBeVisible({ timeout: 15000 });
      await expect(picker.getByTestId('chat-reference-item')).toHaveCount(12, { timeout: 15000 });

      for (let index = 0; index < 8; index += 1) {
        await input.press('ArrowDown');
      }

      await expect.poll(() => picker.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await expect.poll(() => selectedReferenceIsInsidePicker(picker)).toBe(true);

      for (let index = 0; index < 8; index += 1) {
        await input.press('ArrowUp');
      }

      await expect.poll(() => selectedReferenceIsInsidePicker(picker)).toBe(true);
    } finally {
      // The verified workspace creation receipt is cleaned up in afterEach.
    }
  });
});
