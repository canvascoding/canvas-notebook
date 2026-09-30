import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

test('managed skill drafts stay hidden during live creation, refresh, and search', async ({ page }, info) => {
  test.skip(process.env.SKILL_DRAFT_E2E !== '1' || process.env.E2E_EXTERNAL_SERVER !== '1',
    'Requires the managed local host server and its local data directory.');
  test.setTimeout(180_000);
  const base = process.env.BASE_URL!;
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const dataRoot = process.env.CANVAS_DATA_ROOT || process.env.DATA;
  expect(Boolean(email && password && dataRoot), 'Managed local environment is required.').toBe(true);
  const login = await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: base }, data: { email, password },
  });
  expect(login.ok()).toBe(true);
  const listing = await (await page.request.get('/api/workspaces')).json();
  const workspace = listing.workspaces.find((entry: { name: string }) => entry.name === 'Shared Test Workspace');
  expect(workspace?.permissions.canWrite).toBe(true);
  expect(workspace?.rootRelativePath).toBeTruthy();
  const root = path.resolve(dataRoot!, workspace.rootRelativePath);
  expect(root.startsWith(`${path.resolve(dataRoot!)}${path.sep}`)).toBe(true);
  const token = `skill-visibility-${randomUUID()}`;
  const visibleName = `${token}.txt`;
  const liveName = `${token}-live.txt`;
  const draftsRoot = path.join(root, '.canvas-skill-drafts');
  const draftDir = path.join(draftsRoot, token);
  const packageDir = path.join(draftDir, 'visibility-skill');
  const headers = { 'x-canvas-workspace-id': workspace.id };
  try {
    await fs.writeFile(path.join(root, visibleName), 'Visible user file\n', { flag: 'wx' });
    await page.addInitScript(id => {
      localStorage.setItem('canvas.activeWorkspaceId', id);
      localStorage.setItem('canvas.notebook.chatVisible', 'false');
    }, workspace.id);
    await page.goto(`/notebook?workspaceId=${encodeURIComponent(workspace.id)}&panel=files`);
    const search = page.getByRole('textbox', { name: /Search files|Dateien suchen/i }).first();
    await expect(search).toBeVisible({ timeout: 60_000 });
    await search.fill(token);
    await expect(page.getByText(visibleName, { exact: true }).first()).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole('button', { name: /Reconnect|Erneut verbinden/i })).toHaveCount(0, { timeout: 30_000 });

    // Create while the browser's live file subscription is already active.
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, 'SKILL.md'),
      '---\nname: visibility-skill\ndescription: Hidden draft\nmetadata:\n  version: "1.0.0"\n---\nDraft\n');
    await fs.writeFile(path.join(packageDir, `${token}-hidden.txt`), 'Hidden draft resource\n');
    await fs.writeFile(path.join(root, liveName), 'Visible live file\n', { flag: 'wx' });
    await expect(page.getByText(liveName, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    const tree = await page.request.get('/api/files/tree?noCache=1&depth=6', { headers });
    expect(tree.ok()).toBe(true);
    expect(await tree.text()).not.toContain('.canvas-skill-drafts');
    await expect(page.getByText('.canvas-skill-drafts', { exact: true })).toHaveCount(0);
    await expect(page.getByText(`${token}-hidden.txt`, { exact: true })).toHaveCount(0);

    await page.reload();
    const showSidebar = page.getByRole('button', { name: /Show sidebar|Seitenleiste anzeigen/i });
    await expect(search.or(showSidebar).first()).toBeVisible({ timeout: 45_000 });
    if (!(await search.isVisible())) await showSidebar.click();
    await expect(search).toBeVisible({ timeout: 45_000 });
    await search.fill(token);
    await expect(page.getByText(visibleName, { exact: true }).first()).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText(`${token}-hidden.txt`, { exact: true })).toHaveCount(0);
    await search.fill('.canvas-skill-drafts');
    await expect(page.getByText('.canvas-skill-drafts', { exact: true })).toHaveCount(0);
    await search.fill(token);
    await expect(page.getByText(visibleName, { exact: true }).first()).toBeVisible({ timeout: 45_000 });
    const screenshot = info.outputPath('hidden-skill-draft-search.png');
    await page.screenshot({ path: screenshot, fullPage: false });
    await info.attach('hidden-skill-draft-search', {
      path: screenshot, contentType: 'image/png',
    });
  } finally {
    await fs.rm(path.join(root, visibleName), { force: true });
    await fs.rm(path.join(root, liveName), { force: true });
    await fs.rm(draftDir, { recursive: true, force: true });
    await fs.rmdir(draftsRoot).catch(error => {
      if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error;
    });
  }
});
