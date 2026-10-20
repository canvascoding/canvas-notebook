import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { Pool } from 'pg';
import type { CanvasMigrationManifest, MigrationExportJob } from '../app/lib/migration/types';
import {
  artifacts, digest, ensureFixture, inventory, json, login, migrationPost, origin, randomMultiChunkBundle,
  runtimeEnv, sentinel, startRuntime, stopRuntime, syntheticBundle, uploadArchive, zipEntries, zipRead, zipMarkerLeaks,
  type Fixture,
} from './helpers/export-migration-acceptance';

test.skip(process.env.EXPORT_MIGRATION_ACCEPTANCE !== '1', 'Requires explicitly prepared private acceptance databases and data roots.');

const componentLabels = {
  database: 'PostgreSQL-Datenbank', workspace: 'Workspace-Dateien', studioAssets: 'Studio-Assets',
  studioOutputs: 'Studio-Outputs', userUploads: 'User-Uploads', agents: 'Agent-Dateien', skills: 'Skills', secrets: 'Reconnect-Manifest',
};
let admin: BrowserContext;
let fixture: Fixture;
let tracing = false;

async function settings(page: Page, tab: 'workspace' | 'data-migration') {
  const hydrated = tab === 'data-migration'
    ? page.waitForResponse(r => new URL(r.url()).pathname === '/api/admin/organization/status')
    : page.waitForResponse(r => new URL(r.url()).pathname === '/api/workspaces');
  await page.goto(`/de/settings?tab=${tab}`, { waitUntil: 'domcontentloaded' });
  await hydrated;
  if (tab === 'workspace') await expect(page.locator('#workspace-export-selection')).toBeEnabled();
  else await expect(page.getByRole('button', { name: 'Migrations-ZIP erstellen', exact: true })).toBeVisible();
}

async function workspaceDownload(page: Page, workspaceId: string, name: string) {
  await page.locator('#workspace-export-selection').selectOption(workspaceId);
  const button = page.getByRole('button', { name: 'Workspace als ZIP exportieren', exact: true });
  await expect(button).toBeEnabled();
  const ready = page.waitForEvent('download'); await button.click(); const download = await ready;
  expect(await download.failure()).toBeNull();
  const filename = path.join(artifacts, name + '.zip'); await download.saveAs(filename); return filename;
}

async function configureExport(page: Page, components: string[], profile = 'standard', personal = false) {
  await page.getByRole('button', { name: profile === 'standard' ? /^Standard-Migration/ : /^Full Admin Export/ }).click();
  for (const [key, label] of Object.entries(componentLabels)) {
    await page.getByRole('checkbox', { name: new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).setChecked(components.includes(key));
  }
  const include = page.getByRole('checkbox', { name: /^Persönliche Workspaces einschließen/ });
  if (profile === 'full_admin' && components.includes('workspace')) await include.setChecked(personal);
  else await expect(include).toBeDisabled();
}

async function exportDownload(page: Page, name: string) {
  const created = page.waitForResponse(r => r.url().endsWith('/api/migration/export') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Migrations-ZIP erstellen', exact: true }).click();
  const response = await created;
  expect(response.status(), 'The normal export rate limit is respected.').toBe(200);
  const { job } = await response.json() as { job: MigrationExportJob };
  await expect.poll(async () => {
    const current = await json<{ job: MigrationExportJob }>(await page.request.get(`/api/migration/export/${job.id}`));
    if (current.job.status === 'failed') throw new Error(current.job.error || 'Migration export failed');
    return current.job.status;
  }, { timeout: 90_000, intervals: [500, 1_000] }).toBe('completed');
  const ready = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Migrations-ZIP herunterladen', exact: true }).click();
  const download = await ready; expect(await download.failure()).toBeNull();
  const filename = path.join(artifacts, name + '.zip'); await download.saveAs(filename);
  const manifest = JSON.parse(zipRead(filename, 'manifest.json').toString()) as CanvasMigrationManifest;
  const entries = zipEntries(filename);
  for (const entry of manifest.files) {
    expect(entries.find(item => item.path === entry.archivePath)?.size, entry.archivePath).toBe(entry.size);
  }
  expect(manifest.fileCount).toBe(manifest.files.length);
  return { filename, manifest, entries };
}

test.describe('source export and migration acceptance', () => {
  test.beforeAll(async ({ browser }) => {
    await startRuntime('source'); admin = await login(browser); fixture = await ensureFixture(admin.request, browser);
    await admin.tracing.start({ screenshots: true, snapshots: true }); tracing = true;
  });
  test.afterAll(async () => {
    try { if (tracing) await admin.tracing.stop({ path: path.join(artifacts, `source-trace-${test.info().workerIndex}.zip`) }); }
    finally { tracing = false; await admin?.close(); await stopRuntime(); }
  });

  test('WS1 WS2 WS4: actual ZIP bytes for personal, organization, team and project workspaces', async () => {
    const page = await admin.newPage();
    try {
      await page.addInitScript(id => localStorage.setItem('canvas.activeWorkspaceId', id), fixture.active.id);
      await settings(page, 'workspace');
      for (const workspace of fixture.workspaces.filter(workspace => workspace.type !== 'personal' || workspace.ownerUserId === fixture.selected.ownerUserId)) {
        const filename = await workspaceDownload(page, workspace.id, 'workspace-' + workspace.type);
        const env = await runtimeEnv('source');
        const expected = await inventory(path.join(env.DATA, workspace.rootRelativePath));
        const actual = zipEntries(filename).filter(entry => entry.path !== 'workspace/').map(entry => ({
          ...entry, path: entry.path.replace(/^workspace\//, ''),
        }));
        expect(actual.sort((a, b) => a.path.localeCompare(b.path))).toEqual(expected.sort((a, b) => a.path.localeCompare(b.path)));
        for (const other of fixture.workspaces.filter(w => w.id !== workspace.id)) {
          expect(zipRead(filename, 'workspace/export-99b4/überblick 日本語.md').toString()).not.toContain(other.id);
        }
      }
      await page.screenshot({ path: path.join(artifacts, '01-workspace-desktop.png') });
    } finally { await page.close(); }
  });

  test('WS3 WS6 VIEW: rapid selection, refreshed statistics and empty/mobile state', async () => {
    const page = await admin.newPage();
    try {
      await settings(page, 'workspace');
      const select = page.locator('#workspace-export-selection');
      await select.selectOption(fixture.workspaces[1].id); await select.selectOption(fixture.selected.id);
      await select.selectOption(fixture.empty.id);
      await expect(page.getByText('Der ausgewählte Workspace ist leer.', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Workspace als ZIP exportieren', exact: true })).toBeDisabled();
      await page.setViewportSize({ width: 390, height: 844 });
      await select.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(artifacts, '02-empty-mobile.png') });
      const env = await runtimeEnv('source'); const root = path.join(env.DATA, fixture.empty.rootRelativePath);
      await fs.writeFile(path.join(root, 'fresh.txt'), 'new stats bytes');
      try {
        await page.getByRole('button', { name: 'Aktualisieren', exact: true }).last().click();
        await expect(page.getByRole('button', { name: 'Workspace als ZIP exportieren', exact: true })).toBeEnabled();
        const filename = await workspaceDownload(page, fixture.empty.id, 'fresh-statistics');
        expect(zipRead(filename, 'workspace/fresh.txt').toString()).toBe('new stats bytes');
      } finally { await fs.rm(path.join(root, 'fresh.txt'), { force: true }); }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await page.close(); }
  });

  test('AUTH: owner, member, administrator, foreign personal and anonymous boundaries', async ({ browser }) => {
    const member = await login(browser, true); const anonymous = await browser.newContext({ baseURL: origin });
    try {
      const memberListing = await json<{ workspaces: Fixture['workspaces'] }>(await member.request.get('/api/workspaces'));
      const personal = memberListing.workspaces.find(w => w.type === 'personal'); expect(personal).toBeTruthy();
      expect((await member.request.get(`/api/files/download?scope=workspace&workspaceId=${personal!.id}`)).status()).toBe(200);
      expect([403, 404]).toContain((await admin.request.get(`/api/files/download?scope=workspace&workspaceId=${personal!.id}`)).status());
      expect([403, 404]).toContain((await member.request.get(`/api/files/download?scope=workspace&workspaceId=${fixture.selected.id}`)).status());
      const shared = memberListing.workspaces.find(w => w.type === 'organization' || w.type === 'team'); expect(shared).toBeTruthy();
      const denied = await member.request.get(`/api/files/download?scope=workspace&workspaceId=${shared!.id}`);
      expect(denied.status()).toBe(403); expect((await denied.json()).code).toBe('WORKSPACE_EXPORT_ADMIN_REQUIRED');
      expect((await member.request.post('/api/migration/export', { data: {} })).status()).toBe(403);
      expect((await member.request.post('/api/migration/restore', { data: {} })).status()).toBe(403);
      expect((await anonymous.request.get(`/api/files/download?scope=workspace&workspaceId=${fixture.selected.id}`)).status()).toBe(401);
      expect((await admin.request.get('/api/files/download?scope=workspace')).status()).toBe(400);
      expect((await admin.request.get('/api/files/download?scope=data')).status()).toBe(410);
      const page = await member.newPage(); await settings(page, 'workspace');
      await page.locator('#workspace-export-selection').selectOption(shared!.id);
      await expect(page.getByText('Für diesen Workspace ist ein Admin-Export erforderlich', { exact: true })).toBeVisible();
      await page.screenshot({ path: path.join(artifacts, '03-member-permission.png') });
    } finally { await member.close(); await anonymous.close(); }
  });

  test('ERR: missing paths, traversal, symlink, sparse ZIP size, depth and entry limits', async () => {
    const env = await runtimeEnv('source'); const root = path.join(env.DATA, fixture.selected.rootRelativePath);
    const folder = path.join(root, 'limits-99b4'); await fs.mkdir(folder, { recursive: true });
    const query = (file: string) => '/api/files/download?' + new URLSearchParams({ workspaceId: fixture.selected.id, path: file });
    try {
      expect((await admin.request.get(query('missing-99b4.txt'))).status()).toBe(404);
      expect([400, 403]).toContain((await admin.request.get(query('../outside'))).status());
      await fs.symlink('/etc/hosts', path.join(folder, 'symlink'));
      let response = await admin.request.get(query('limits-99b4')); expect((await response.json()).code).toBe('ARCHIVE_SYMBOLIC_LINK');
      await fs.unlink(path.join(folder, 'symlink'));
      const sparse = await fs.open(path.join(folder, 'sparse.bin'), 'w'); await sparse.truncate(1024 * 1024 * 1024 + 1); await sparse.close();
      response = await admin.request.get(query('limits-99b4')); expect(response.status()).toBe(413);
      expect((await response.json()).code).toBe('ARCHIVE_TOO_LARGE'); await fs.unlink(path.join(folder, 'sparse.bin'));
      const deep = path.join(folder, ...Array(66).fill('d')); await fs.mkdir(deep, { recursive: true });
      response = await admin.request.get(query('limits-99b4')); expect((await response.json()).code).toBe('ARCHIVE_TOO_DEEP');
      await fs.rm(folder, { recursive: true }); await fs.mkdir(folder);
      for (let start = 0; start < 10_001; start += 100) await Promise.all(Array.from({ length: Math.min(100, 10_001 - start) }, (_, n) => fs.writeFile(path.join(folder, `${start + n}.txt`), '')));
      response = await admin.request.get(query('limits-99b4')); expect(response.status()).toBe(413);
      expect((await response.json()).code).toBe('ARCHIVE_TOO_MANY_ENTRIES');
    } finally { await fs.rm(folder, { recursive: true, force: true }); }
  });

  test('WS5: a newly edited native Excalidraw scene is materialized in its workspace ZIP', async () => {
    const nonce = String(Date.now()); const drawingPath = `export-99b4/current-${nonce}.excalidraw`;
    const created = await json<{ document: { documentId: string; lifecycleGeneration: number; sceneSequence: number } }>(await admin.request.post('/api/excalidraw/scenes', {
      data: { workspaceId: fixture.selected.id, path: drawingPath, idempotencyKey: 'export-99b4-native-create-' + nonce },
    }));
    const operation = await json<{ operation: { status: string } }>(await admin.request.post(`/api/excalidraw/scenes/${created.document.documentId}/operations`, {
      data: { workspaceId: fixture.selected.id, documentId: created.document.documentId,
        lifecycleGeneration: created.document.lifecycleGeneration, observedSceneSequence: created.document.sceneSequence,
        idempotencyKey: 'export-99b4-edit-' + nonce, actions: [{ type: 'create', element: { id: 'current-shape', type: 'rectangle',
          version: 1, versionNonce: 10, isDeleted: false, x: 77, y: 55, width: 100, height: 80,
          angle: 0, opacity: 100, groupIds: [], boundElements: [] } }] },
    }));
    expect(operation.operation.status).toBe('applied');
    const current = await json<{ document: { elements: unknown[] } }>(await admin.request.get(`/api/excalidraw/scenes/${created.document.documentId}?workspaceId=${fixture.selected.id}`));
    const page = await admin.newPage();
    try {
      await settings(page, 'workspace'); const filename = await workspaceDownload(page, fixture.selected.id, 'workspace-current-scene');
      const scene = JSON.parse(zipRead(filename, 'workspace/' + drawingPath).toString());
      expect(scene.elements).toEqual(current.document.elements);
      expect(scene.elements.find((element: { id: string }) => element.id === 'current-shape')?.x).toBe(77);
    } finally { await page.close(); }
  });

  test('WS5: Markdown edited in the visible native editor immediately reaches the downloaded ZIP', async () => {
    const page = await admin.newPage(); const exportPage = await admin.newPage();
    const nonce = Date.now();
    const documentName = `current-${nonce}.md`;
    const documentPath = 'export-99b4/' + documentName;
    // Markdown serialization escapes underscores. Use a plain alphanumeric
    // marker so the assertion compares content rather than source escaping.
    const marker = `EXPORTCURRENT${nonce}`;
    try {
      await json(await admin.request.post('/api/files/create?' + new URLSearchParams({ workspaceId: fixture.selected.id }), {
        data: { path: documentPath, type: 'file' },
      }));
      await fs.writeFile(path.join(artifacts, 'markdown-export-result.json'), JSON.stringify({ phase: 'opening_editor', nativeSyncReady: false }, null, 2));
      await page.addInitScript(id => localStorage.setItem('canvas.activeWorkspaceId', id), fixture.selected.id);
      await page.goto('/de/notebook?' + new URLSearchParams({ workspaceId: fixture.selected.id, path: documentPath, collaborationDebug: '1' }), { waitUntil: 'domcontentloaded' });
      const panel = page.getByRole('tabpanel', { name: documentName, exact: true });
      await expect(panel).toBeVisible();
      await panel.getByRole('button', { name: 'Bearbeiten', exact: true }).click();
      const editor = panel.locator('[contenteditable=true]').first(); await expect(editor).toBeVisible();
      const diagnostic = panel.getByTestId('markdown-save-state').locator('pre');
      let sync: Record<string, unknown> = {};
      try {
        await expect.poll(async () => {
          sync = JSON.parse(await diagnostic.innerText());
          return sync.remoteSynced === true && sync.connection === 'live';
        }, { timeout: 30_000 }).toBe(true);
      } catch (error) {
        await fs.writeFile(path.join(artifacts, 'markdown-export-result.json'), JSON.stringify({ phase: 'native_sync_preflight',
          nativeSyncReady: false, connection: sync.connection, remoteSynced: sync.remoteSynced,
          durability: sync.durability, unsyncedChanges: sync.unsyncedChanges }, null, 2));
        throw error;
      }
      await editor.focus(); await editor.press('ControlOrMeta+A'); await editor.pressSequentially('Aktuell bearbeitet ' + marker);
      await expect(editor).toContainText(marker);
      const env = await runtimeEnv('source');
      let serverContainsMarker = false;
      let serverStatus = 0;
      try {
        await expect.poll(async () => {
          const response = await admin.request.get('/api/files/read?' + new URLSearchParams({ workspaceId: fixture.selected.id, path: documentPath }));
          serverStatus = response.status(); const payload = await response.json();
          serverContainsMarker = response.ok() && payload.data?.content?.includes(marker) === true;
          return serverContainsMarker;
        }, { timeout: 30_000 }).toBe(true);
      } catch (error) {
        sync = JSON.parse(await diagnostic.innerText());
        await fs.writeFile(path.join(artifacts, 'markdown-export-result.json'), JSON.stringify({ phase: 'native_edit_persistence',
          nativeSyncReady: true, serverContainsMarker, serverStatus, visibleContainsMarker: (await editor.innerText()).includes(marker),
          connection: sync.connection, durability: sync.durability, unsyncedChanges: sync.unsyncedChanges,
          failure: sync.failure, projectionError: sync.projectionError }, null, 2));
        throw error;
      }
      await page.screenshot({ path: path.join(artifacts, '08-current-markdown-editor.png') });
      await settings(exportPage, 'workspace');
      const filename = await workspaceDownload(exportPage, fixture.selected.id, 'workspace-current-markdown');
      const exported = zipRead(filename, 'workspace/' + documentPath);
      const physical = await fs.readFile(path.join(env.DATA, fixture.selected.rootRelativePath, documentPath));
      await fs.writeFile(path.join(artifacts, 'markdown-export-result.json'), JSON.stringify({ phase: 'export', marker, nativeSyncReady: true, serverContainsMarker,
        visibleContainsMarker: (await editor.innerText()).includes(marker), exportedContainsMarker: exported.includes(Buffer.from(marker)),
        physicalContainsMarker: physical.includes(Buffer.from(marker)), exportedSha256: digest(exported), physicalSha256: digest(physical) }, null, 2));
      expect(exported.toString()).toContain(marker);
      await expect.poll(() => fs.readFile(path.join(env.DATA, fixture.selected.rootRelativePath, documentPath), 'utf8')).toContain(marker);
    } finally { await page.close(); await exportPage.close(); }
  });

  test('ALL1 ALL2: standard and explicit full-admin exports contain exactly selected workspace files', async () => {
    const page = await admin.newPage();
    try {
      await settings(page, 'data-migration');
      await configureExport(page, ['workspace']); const standard = await exportDownload(page, 'standard-workspaces');
      expect(standard.entries.some(e => e.path.startsWith('data/workspaces/personal/'))).toBe(false);
      await configureExport(page, ['workspace'], 'full_admin', false); const without = await exportDownload(page, 'full-admin-without-personal');
      expect(without.entries.some(e => e.path.startsWith('data/workspaces/personal/'))).toBe(false);
      await configureExport(page, ['workspace'], 'full_admin', true); const full = await exportDownload(page, 'all-workspaces');
      expect(full.manifest.selection?.includePersonalWorkspaces).toBe(true);
      await page.screenshot({ path: path.join(artifacts, '04-full-admin-export.png') });
      const env = await runtimeEnv('source');
      const comparison: Array<{ type: string; workspaceId: string; filesChecked: number; missing: string[] }> = [];
      for (const workspace of fixture.workspaces) {
        const files = (await inventory(path.join(env.DATA, workspace.rootRelativePath))).filter(e => !e.directory && e.path.startsWith('export-99b4/'));
        const missing: string[] = [];
        for (const file of files) {
          const archivePath = `data/${workspace.rootRelativePath}/${file.path}`;
          const actual = full.entries.find(e => e.path === archivePath);
          if (!actual) missing.push(archivePath);
          expect.soft(actual?.sha256, archivePath).toBe(file.sha256);
        }
        comparison.push({ type: workspace.type, workspaceId: workspace.id, filesChecked: files.length, missing });
      }
      await fs.writeFile(path.join(artifacts, 'all-workspace-comparison.json'), JSON.stringify(comparison, null, 2));
    } finally { await page.close(); }
  });

  test('ALL3 SEC: component fidelity, excluded managed secrets and reconnect manifest', async () => {
    const page = await admin.newPage();
    try {
      await settings(page, 'data-migration');
      await configureExport(page, ['workspace', 'studioAssets', 'studioOutputs', 'userUploads', 'agents', 'skills', 'secrets'], 'full_admin', true);
      const exported = await exportDownload(page, 'selected-components');
      for (const entry of ['data/studio/assets/export-99b4.txt', 'data/studio/outputs/export-99b4.txt', 'data/user-uploads/export-99b4.txt', 'data/agents/export-99b4.txt', 'data/skills/export-99b4/SKILL.md']) {
        expect(exported.entries.some(e => e.path === entry), entry).toBe(true);
      }
      expect(exported.entries.some(e => e.path.includes('/mcp-oauth/'))).toBe(false);
      expect(exported.entries.some(e => e.path.endsWith('/Canvas-Secrets.env'))).toBe(false);
      expect(zipMarkerLeaks(exported.filename, [sentinel, fixture.publicShareToken])).toEqual([]);
      const reconnect = zipRead(exported.filename, 'data/reconnect-manifest.json').toString();
      expect(reconnect).toContain('EXPORT_E2E_SENTINEL'); expect(reconnect).not.toContain(sentinel);
      expect(exported.manifest.security?.publicLinksIncluded).toBe(false);
      expect(exported.manifest.security?.publicLinkTokensIncluded).toBe(false);
      expect(exported.manifest.security?.rawSecretsIncluded).toBe(false);
    } finally { await page.close(); }
  });

  test('DB: explicit full-admin export contains real PostgreSQL rows without live credentials', async () => {
    const page = await admin.newPage(); const env = await runtimeEnv('source');
    const database = new Pool({ connectionString: env.DATABASE_URL });
    const accountId = 'migration-oauth-fixture-99b4';
    try {
      const actor = await json<{ user: { id: string } }>(await admin.request.get('/api/auth/get-session'));
      const template = (await database.query("SELECT * FROM account WHERE user_id=$1 AND provider_id='credential' LIMIT 1", [actor.user.id])).rows[0];
      expect(template).toBeTruthy();
      await database.query("DELETE FROM account WHERE id=$1 AND provider_id='migration-test-fixture'", [accountId]);
      await database.query('INSERT INTO account SELECT * FROM json_populate_record(NULL::account,$1::json)', [JSON.stringify({
        ...template, id: accountId, account_id: 'fixture-account-99b4', provider_id: 'migration-test-fixture', password: null,
        access_token: sentinel, refresh_token: sentinel, id_token: sentinel,
      })]);
      const proof = await json<{ project: { id: string; name: string } }>(await admin.request.post('/api/projects', { data: { name: 'Migration DB proof 99b4 ' + Date.now() } }));
      const unicodeDescription = 'Übertragung 日本語 A\u2028B\u2029C';
      await database.query('UPDATE canvas_projects SET description=$1 WHERE id=$2 AND name=$3', [unicodeDescription, proof.project.id, proof.project.name]);
      const sourceAutomationCount = Number((await database.query('SELECT count(*)::text count FROM automation_jobs')).rows[0].count);
      expect(sourceAutomationCount).toBeGreaterThan(0);
      const sourceStatus = await json<{ instanceId: string; licensed: boolean }>(await admin.request.get('/api/license/status'));
      const cert = (await database.query('SELECT cert FROM license_certs WHERE instance_id=$1 ORDER BY id DESC LIMIT 1', [sourceStatus.instanceId])).rows[0].cert as string;
      const licenseId = JSON.parse(Buffer.from(cert.split('.')[1], 'base64url').toString()).licenseId || digest(Buffer.from(cert));
      await fs.writeFile(path.join(artifacts, 'database-proof.json'), JSON.stringify({ project: proof.project,
        sourceInstanceId: sourceStatus.instanceId, sourceLicenseId: licenseId, unicodeDescription, sourceAutomationCount }, null, 2), { mode: 0o600 });
      await settings(page, 'data-migration'); await configureExport(page, ['database', 'workspace'], 'full_admin', true);
      const exported = await exportDownload(page, 'database-selection');
      expect(exported.manifest.database?.backupKind).toBe('postgres_rows');
      expect(exported.manifest.database?.artifactPath).toBe('data/database/postgres.jsonl.gz');
      const { execFileSync } = await import('node:child_process');
      const summary = JSON.parse(execFileSync('python3', ['-c',
        'import zipfile,gzip,json,sys,hashlib\nz=zipfile.ZipFile(sys.argv[1]); f=gzip.GzipFile(fileobj=z.open("data/database/postgres.jsonl.gz")); h=json.loads(f.readline()); n=0; tokens=0; excluded=0; fixture=False; trailer=None; native=[]\nfor line in f:\n r=json.loads(line)\n if r.get("end"): trailer=r; continue\n n+=1; t=r["table"]; v=r["row"]\n if t=="account":\n  tokens+=int(any(v.get(k) is not None for k in ["access_token","refresh_token","id_token"]))\n  fixture=fixture or v["id"]=="migration-oauth-fixture-99b4"\n if t=="collaboration_yjs_states" and v["path"].startswith("export-99b4/current-") and v["status"]=="active": native.append(dict(id=v["document_id"],sha256=hashlib.sha256(bytes.fromhex(v["yjs_state"][2:])).hexdigest()))\n excluded+=int(t in ["session","oauth_access_token","public_file_shares","license_certs","license_public_keys","team_memberships"])\nassert trailer and trailer["rowCount"]==n\nprint(json.dumps(dict(format=h["format"],rows=n,accountsWithTokens=tokens,excludedRows=excluded,fixturePresent=fixture,nativeStateHashes=native)))', exported.filename], { encoding: 'utf8', maxBuffer: 65536 }));
      expect(summary.nativeStateHashes.length).toBeGreaterThan(0);
      expect(summary.format).toBe('canvas-postgres-rows'); expect(summary.rows).toBeGreaterThan(100);
      expect(summary.accountsWithTokens).toBe(0); expect(summary.excludedRows).toBe(0); expect(summary.fixturePresent).toBe(true);
      await fs.writeFile(path.join(artifacts, 'database-snapshot-result.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
      const completed = page.waitForResponse(response => /\/api\/migration\/uploads\/[^/]+\/complete$/.test(response.url()));
      await page.locator('input[type=file]').setInputFiles(exported.filename);
      const result = await (await completed).json(); expect(result.inspection.canRestore).toBe(true);
      await expect(page.getByRole('button', { name: 'Full Restore starten', exact: true })).toBeEnabled();
      await page.getByText('Dry Run bestanden', { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(artifacts, '14-postgres-snapshot-ready.png') });
    } finally {
      await database.query("DELETE FROM account WHERE id=$1 AND provider_id='migration-test-fixture'", [accountId]);
      await database.end(); await page.close();
    }
  });

  test('DB LEGACY: metadata-only PostgreSQL archives remain blocked', async () => {
    const filename = await syntheticBundle('synthetic-database-metadata-only');
    const { execFileSync } = await import('node:child_process');
    execFileSync('python3', ['-c',
      'import zipfile,json,sys,os\np=sys.argv[1]; z=zipfile.ZipFile(p); entries={n:z.read(n) for n in z.namelist()}; z.close(); m=json.loads(entries["manifest.json"]); m["components"]["database"]=True; m["database"]={"provider":"postgres","backupKind":"none","artifactPath":None}; entries["manifest.json"]=json.dumps(m).encode(); out=zipfile.ZipFile(p+".new","w"); [out.writestr(k,v) for k,v in entries.items()]; out.close(); os.replace(p+".new",p)', filename]);
    const result = await uploadArchive(admin.request, filename);
    expect(result.payload.inspection.canRestore).toBe(false);
    expect(result.payload.inspection.dryRun.blockers.join(' ')).toContain('portable row snapshot');
  });

  test('UP1: real UI uploads an archive larger than one chunk and verifies exact bytes', async () => {
    const filename = await randomMultiChunkBundle(); const page = await admin.newPage();
    try {
      await settings(page, 'data-migration'); const parts: number[] = [];
      page.on('request', request => { if (request.method() === 'PUT' && request.url().includes('/api/migration/uploads/')) parts.push(Number(new URL(request.url()).searchParams.get('partIndex'))); });
      const completed = page.waitForResponse(r => /\/api\/migration\/uploads\/[^/]+\/complete$/.test(r.url()));
      await page.locator('input[type=file]').setInputFiles(filename); const response = await completed;
      const payload = await response.json(); expect(response.status()).toBe(200); expect(parts).toEqual([0, 1]);
      expect(payload.upload.archiveSha256).toBe(digest(await fs.readFile(filename)));
      expect(payload.upload.receivedParts).toEqual([0, 1]); expect(payload.inspection.canRestore).toBe(true);
      await expect(page.getByText('Dry Run bestanden', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Full Restore starten', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(artifacts, '06-upload-ready-desktop.png') });
    } finally { await page.close(); }
  });

  test('MAP: an actual full-workspace UI export recognizes exact registered workspace roots', async () => {
    const page = await admin.newPage();
    try {
      await settings(page, 'data-migration');
      const completed = page.waitForResponse(r => /\/api\/migration\/uploads\/[^/]+\/complete$/.test(r.url()));
      await page.locator('input[type=file]').setInputFiles(path.join(artifacts, 'all-workspaces.zip'));
      const payload = await (await completed).json(); expect(payload.inspection.canRestore).toBe(true);
      expect(payload.inspection.dryRun.workspaces.every((mapping: { status: string }) => mapping.status === 'mapped')).toBe(true);
      await expect(page.getByRole('button', { name: 'Full Restore starten', exact: true })).toBeEnabled();
      await page.getByText('Dry Run bestanden', { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(artifacts, '09-actual-bundle-mapping-ready.png') });
    } finally { await page.close(); }
  });

  test('MAP LOCKED: copied disabled/recovery-locked workspace roots cannot silently become active imports', async () => {
    const archive = path.join(path.dirname(artifacts), 'baseline-2026-10-20-blocked/all-workspaces.zip');
    const result = await uploadArchive(admin.request, archive);
    expect(result.response.status()).toBe(200);
    expect(result.payload.inspection.canRestore).toBe(false);
    expect(result.payload.inspection.dryRun.blockers.join(' ')).toContain('Workspace mapping unresolved');
  });

  test('UP2 MAP: corrupt/version/schema/path/chunk and differing user/project mappings are blocked', async () => {
    for (const [name, options] of [
      ['unsafe', { entry: '../escape.txt' }], ['newer', { appVersion: '9999.1.1.1' }],
      ['schema', { schema: 999 }], ['foreign-user', { entry: 'data/workspaces/personal/foreign-99b4/files/note.md' }],
      ['foreign-team', { entry: 'data/workspaces/team/foreign-org-99b4/files/note.md' }],
      ['project', { entry: 'data/workspaces/project/foreign-project-99b4/files/note.md' }],
    ] as const) {
      const uploaded = await uploadArchive(admin.request, await syntheticBundle('synthetic-' + name, options));
      expect(uploaded.response.status(), name).toBe(200); expect(uploaded.payload.inspection.canRestore, name).toBe(false);
    }
    const corrupt = path.join(artifacts, 'synthetic-corrupt.zip'); await fs.writeFile(corrupt, 'not a zip');
    expect((await uploadArchive(admin.request, corrupt)).response.status()).toBe(400);
    const created = await json<{ upload: { id: string } }>(await migrationPost(admin.request, '/api/migration/uploads', {
      data: { fileName: 'incomplete.zip', totalBytes: 10, totalParts: 2 },
    }));
    const id = created.upload.id;
    expect((await admin.request.put(`/api/migration/uploads/${id}?partIndex=0&expectedBytes=10`, { data: Buffer.from('short') })).status()).toBe(400);
    expect((await migrationPost(admin.request, `/api/migration/uploads/${id}/complete`)).status()).toBe(400);
    expect((await admin.request.post('/api/migration/restore', { data: { uploadId: id, confirmation: 'WRONG' } })).status()).toBe(400);
    expect(await fs.stat(path.join((await runtimeEnv('source')).DATA, '.migration/pending-restore.json')).then(() => true, () => false)).toBe(false);
  });

  test('ALL4: the migration bundle preserves empty directories from a selected workspace', async () => {
    const entries = zipEntries(path.join(artifacts, 'all-workspaces.zip'));
    const directory = `data/${fixture.selected.rootRelativePath}/export-99b4/Ordner mit Leerzeichen/leer/`;
    expect(entries.some(entry => entry.path === directory && entry.directory), 'Empty directories are part of the source file tree.').toBe(true);
  });

  test('AUTH: prepared ZIPs belong to one session and can only be downloaded once', async ({ browser }) => {
    const other = await login(browser);
    try {
      const prepared = await json<{ downloadUrl: string }>(await admin.request.get('/api/files/download?' + new URLSearchParams({
        scope: 'workspace', workspaceId: fixture.selected.id, prepare: '1',
      })));
      expect((await other.request.get(prepared.downloadUrl)).status()).toBe(403);
      const downloaded = await admin.request.get(prepared.downloadUrl);
      expect(downloaded.status()).toBe(200);
      expect(downloaded.headers()['content-type']).toContain('application/zip');
      expect((await downloaded.body()).subarray(0, 2).toString()).toBe('PK');
      expect((await admin.request.get(prepared.downloadUrl)).status()).toBe(410);
    } finally { await other.close(); }
  });

  test('ERR VIEW: a rejected ZIP download displays an actionable error in settings', async () => {
    const env = await runtimeEnv('source'); const symlink = path.join(env.DATA, fixture.selected.rootRelativePath, 'export-error-99b4-link');
    await fs.symlink('/etc/hosts', symlink); const page = await admin.newPage();
    try {
      await settings(page, 'workspace'); await page.locator('#workspace-export-selection').selectOption(fixture.selected.id);
      const backend = await admin.request.get('/api/files/download?' + new URLSearchParams({ scope: 'workspace', workspaceId: fixture.selected.id }));
      expect(backend.status()).toBe(400); const error = (await backend.json()).error as string;
      const download = page.waitForEvent('download', { timeout: 5_000 }).catch(() => null);
      await page.getByRole('button', { name: 'Workspace als ZIP exportieren', exact: true }).click();
      const event = await download; const browserFailure = event ? await event.failure() : 'No browser download event';
      await page.waitForLoadState('domcontentloaded');
      await page.screenshot({ path: path.join(artifacts, '10-download-error-desktop.png') });
      await fs.writeFile(path.join(artifacts, 'download-error-result.json'), JSON.stringify({ httpStatus: backend.status(),
        error, browserFailure, stayedInSettings: new URL(page.url()).pathname.endsWith('/settings'), visibleError: await page.getByText(error, { exact: true }).count() > 0 }, null, 2));
      await expect(page.getByText(error, { exact: true }), 'A failed server response must be presented to the user.').toBeVisible();
    } finally { await page.close(); await fs.unlink(symlink); }
  });
});

test.describe('isolated target restore acceptance', () => {
  test.beforeAll(async ({ browser }) => {
    await startRuntime('target'); admin = await login(browser);
    await admin.tracing.start({ screenshots: true, snapshots: true }); tracing = true;
  });
  test.afterAll(async () => {
    try { if (tracing) await admin.tracing.stop({ path: path.join(artifacts, `target-trace-${test.info().workerIndex}.zip`) }); }
    finally { tracing = false; await admin?.close(); await stopRuntime(); }
  });

  test('REST: a ready file restore must actually apply after application restart', async ({ browser }) => {
    const target = await runtimeEnv('target'); const file = path.join(target.DATA, 'workspace/export-99b4/restore.txt');
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'TARGET BEFORE RESTORE 99b4\n');
    const filename = await syntheticBundle('synthetic-restore-executor'); const page = await admin.newPage();
    const before = await json<{ instanceId: string }>(await admin.request.get('/api/license/status'));
    const readLicenseIdentity = async () => {
      const database = new Pool({ connectionString: target.DATABASE_URL });
      try {
        const result = await database.query('SELECT cert FROM license_certs WHERE instance_id=$1 ORDER BY id DESC LIMIT 1', [before.instanceId]);
        const certificate = result.rows[0]?.cert as string | undefined;
        if (!certificate) throw new Error('A persisted target license is required to verify license preservation.');
        const claims = JSON.parse(Buffer.from(certificate.split('.')[1], 'base64url').toString());
        return typeof claims.licenseId === 'string' ? claims.licenseId : digest(Buffer.from(certificate));
      } finally { await database.end(); }
    };
    const targetLicenseBefore = await readLicenseIdentity();
    const oldSession = await json<{ session: { id: string } }>(await admin.request.get('/api/auth/get-session'));
    const oauthMarker = path.join(target.DATA, 'settings/mcp-oauth/restore-99b4.json');
    await fs.mkdir(path.dirname(oauthMarker), { recursive: true }); await fs.writeFile(oauthMarker, JSON.stringify({ accessToken: 'restore-fixture-only' }));
    const fixturesDatabase = new Pool({ connectionString: target.DATABASE_URL });
    const jobId = `restore-fixture-99b4-${Date.now()}`;
    try {
      let template = (await fixturesDatabase.query('SELECT * FROM automation_jobs LIMIT 1')).rows[0];
      if (!template) {
        const sourceDatabase = new Pool({ connectionString: (await runtimeEnv('source')).DATABASE_URL });
        try { template = (await sourceDatabase.query('SELECT * FROM automation_jobs LIMIT 1')).rows[0]; }
        finally { await sourceDatabase.end(); }
      }
      if (!template) throw new Error('A source automation definition is required for the isolated dormant fixture.');
      // This fixture tests restore pausing, not automation creation or execution.
      // It stays in the guarded target DB and cannot become due before 2099.
      const row = { ...template, id: jobId, name: 'Restore acceptance future fixture 99b4',
        prompt: 'Dormant restore fixture; do not execute.', status: 'active', composio_profile_id: null,
        job_type: 'default', trigger_kind: 'schedule', schedule_kind: 'once',
        next_run_at: Date.parse('2099-01-01T11:00:00Z'),
        schedule_config_json: JSON.stringify({ kind: 'once', date: '2099-01-01', time: '12:00', timeZone: 'Europe/Berlin' }) };
      await fixturesDatabase.query('INSERT INTO automation_jobs SELECT * FROM json_populate_record(NULL::automation_jobs,$1::json)', [JSON.stringify(row)]);
    } finally { await fixturesDatabase.end(); }
    try {
      await settings(page, 'data-migration');
      const completed = page.waitForResponse(r => /\/api\/migration\/uploads\/[^/]+\/complete$/.test(r.url()));
      await page.locator('input[type=file]').setInputFiles(filename);
      expect((await (await completed).json()).inspection.canRestore).toBe(true);
      page.once('dialog', dialog => dialog.accept('FULL_RESTORE'));
      const staged = page.waitForResponse(r => r.url().endsWith('/api/migration/restore'));
      await page.getByRole('button', { name: 'Full Restore starten', exact: true }).click();
      const stagedResponse = await staged; const stagedPayload = await stagedResponse.json(); expect(stagedResponse.status()).toBe(200);
      expect(stagedPayload.pending.preserveTargetInstanceAndLicense).toBe(true);
      await page.screenshot({ path: path.join(artifacts, '07-restore-staged.png') });
      const pendingFile = path.join(target.DATA, '.migration/pending-restore.json');
      expect((await fs.stat(pendingFile)).mode & 0o777).toBe(0o600);
      await stopRuntime(); await startRuntime('target');
      const afterSessionResponse = await admin.request.get('/api/auth/get-session'); const afterSession = await afterSessionResponse.json();
      const fresh = await login(browser);
      try {
        const after = await json<{ instanceId: string }>(await fresh.request.get('/api/license/status'));
        const database = new Pool({ connectionString: target.DATABASE_URL });
        const automationStatus = await database.query('SELECT status FROM automation_jobs WHERE id=$1', [jobId]).then(result => result.rows[0]?.status);
        await database.query('DELETE FROM automation_jobs WHERE id=$1', [jobId]);
        await database.end();
        const evidence = { staged: true, restartScheduled: stagedPayload.restartScheduled,
          actualContent: await fs.readFile(file, 'utf8'), expectedContent: 'SOURCE RESTORE CONTENT 99b4\n',
          pendingStillPresent: await fs.stat(pendingFile).then(() => true, () => false),
          previousSessionStillValid: afterSession?.session?.id === oldSession.session.id,
          targetInstancePreserved: after.instanceId === before.instanceId, targetLicensePreserved: await readLicenseIdentity() === targetLicenseBefore,
          oauthMarkerStillPresent: await fs.stat(oauthMarker).then(() => true, () => false), automationStatus };
        await fs.writeFile(path.join(artifacts, 'restore-result.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
        expect.soft(evidence.targetInstancePreserved).toBe(true); expect.soft(evidence.targetLicensePreserved).toBe(true);
        expect.soft(evidence.actualContent, 'Restore must publish source bytes, not only stage a job.').toBe(evidence.expectedContent);
        expect.soft(evidence.pendingStillPresent, 'A completed restore consumes its pending request.').toBe(false);
        expect.soft(evidence.previousSessionStillValid, 'The promised session invalidation must be applied.').toBe(false);
        expect.soft(evidence.oauthMarkerStillPresent, 'The promised OAuth reset must be applied.').toBe(false);
        expect.soft(evidence.automationStatus, 'The promised automation pause must be applied.').toBe('paused');
        const receipt = await fresh.newPage();
        await settings(receipt, 'data-migration');
        await expect(receipt.getByTestId('migration-restore-receipt')).toContainText('Migration abgeschlossen');
        await receipt.setViewportSize({ width: 390, height: 844 });
        await receipt.getByTestId('migration-restore-receipt').scrollIntoViewIfNeeded();
        await receipt.screenshot({ path: path.join(artifacts, '11-restore-completed-mobile.png') });
        expect(await receipt.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await receipt.close();
      } finally { await fresh.close(); }
    } finally { await page.close(); }
  });
  test('TRANSFER: actual all-workspace archive applies with explicit different target roots and remains visible after restart', async ({ browser }) => {
    const filename = path.join(artifacts, 'all-workspaces.zip');
    const manifest = JSON.parse(zipRead(filename, 'manifest.json').toString()) as CanvasMigrationManifest;
    let context = await login(browser);
    let page = await context.newPage();
    try {
      const existing = (await json<{ workspaces: Array<{ id: string; name: string; type: string }> }>(await context.request.get('/api/workspaces'))).workspaces;
      const actor = await json<{ user: { id: string } }>(await context.request.get('/api/auth/get-session'));
      const targets = new Map<string, string>();
      for (const source of manifest.workspaces || []) {
        if (source.type === 'personal' && source.ownerUserId !== actor.user.id) {
          targets.set(source.id, source.id); continue;
        }
        const name = 'Migration target 99b4 ' + source.id;
        let target = existing.find(workspace => workspace.name === name);
        if (!target) {
          let projectId: string | undefined;
          if (source.type === 'project') projectId = (await json<{ project: { id: string } }>(await context.request.post('/api/projects', { data: { name } }))).project.id;
          target = (await json<{ workspace: typeof existing[number] }>(await context.request.post('/api/workspaces', {
            data: { type: source.type === 'organization' ? 'team' : source.type, name, ...(projectId ? { projectId } : {}) },
          }))).workspace;
        }
        targets.set(source.id, target.id);
      }
      await settings(page, 'data-migration');
      const completed = page.waitForResponse(response => /\/api\/migration\/uploads\/[^/]+\/complete$/.test(response.url()));
      await page.locator('input[type=file]').setInputFiles(filename);
      let inspection = (await (await completed).json()).inspection;
      for (const mapping of inspection.dryRun.workspaces as Array<{ sourcePath: string; sourceWorkspaceId: string; targetWorkspaceId: string; kind: string; status: string }>) {
        if (mapping.kind === 'legacy') continue;
        const target = targets.get(mapping.sourceWorkspaceId);
        expect(target, mapping.sourcePath).toBeTruthy();
        if (mapping.status === 'mapped' && mapping.targetWorkspaceId === target) continue;
        const updated = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().includes('/api/migration/uploads/'));
        await page.getByLabel('Ziel-Workspace für ' + mapping.sourcePath, { exact: true }).selectOption(target!);
        const response = await updated;
        expect(response.status()).toBe(200);
        inspection = (await response.json()).upload.inspection;
      }
      expect(inspection.canRestore).toBe(true);
      expect(inspection.dryRun.workspaces.some((mapping: { sourcePath: string; targetPath: string }) => mapping.sourcePath !== mapping.targetPath)).toBe(true);
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const mappedRow = inspection.dryRun.workspaces.find((mapping: { kind: string }) => mapping.kind !== 'legacy');
      await page.getByLabel('Ziel-Workspace für ' + mappedRow.sourcePath, { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(artifacts, '12-explicit-workspace-mapping-mobile.png') });
      page.once('dialog', dialog => dialog.accept('FULL_RESTORE'));
      const staged = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/migration/restore'));
      await page.getByRole('button', { name: 'Full Restore starten', exact: true }).click();
      expect((await staged).status()).toBe(200);
      await page.close(); await context.close();
      await stopRuntime(); await startRuntime('target');
      context = await login(browser); page = await context.newPage();
      const targetEnv = await runtimeEnv('target');
      let checked = 0;
      const expectedHashes = new Map(zipEntries(filename).filter(entry => !entry.directory).map(entry => [entry.path, entry.sha256]));
      for (const file of manifest.files) {
        const mapping = [...inspection.dryRun.workspaces].sort((a, b) => b.sourcePath.length - a.sourcePath.length)
          .find(mapping => file.archivePath.startsWith(mapping.sourcePath + '/'));
        expect(mapping, file.archivePath).toBeTruthy();
        const destination = mapping.targetPath.slice(5) + file.archivePath.slice(mapping.sourcePath.length);
        expect(digest(await fs.readFile(path.join(targetEnv.DATA, destination))), destination).toBe(expectedHashes.get(file.archivePath));
        checked++;
      }
      expect(checked).toBeGreaterThan(5);
      const source = manifest.workspaces!.find(workspace => workspace.displayName === 'Export E2E Personal 99b4')!;
      const importedDocument = manifest.files.find(file => file.archivePath.startsWith('data/' + source.rootRelativePath + '/export-99b4/current-') && file.archivePath.endsWith('.md'))!;
      const relative = importedDocument.archivePath.slice(('data/' + source.rootRelativePath + '/').length);
      const id = targets.get(source.id)!;
      const content = zipRead(filename, importedDocument.archivePath).toString();
      await page.addInitScript(workspaceId => localStorage.setItem('canvas.activeWorkspaceId', workspaceId), id);
      await page.goto('/de/notebook?' + new URLSearchParams({ workspaceId: id, path: relative }), { waitUntil: 'domcontentloaded' });
      const panel = page.getByRole('tabpanel', { name: path.posix.basename(relative), exact: true });
      // Native Markdown is rendered: serialization escapes are absent from the
      // visible text. Exact archive/file bytes were checked above for every file.
      await expect(panel).toContainText(content.trim().replace(/\\/g, ''));
      await page.screenshot({ path: path.join(artifacts, '13-migrated-native-markdown.png') });
      await fs.writeFile(path.join(artifacts, 'actual-file-transfer-result.json'), JSON.stringify({ checked, differentTargetRoots: true, nativeDocumentVisible: true }, null, 2), { mode: 0o600 });
    } finally { await page.close(); await context.close(); }
  });

  test('DB TRANSFER: real PostgreSQL snapshot and files survive restart while distinct target identity, license and API keys remain', async ({ browser }) => {
    const filename = path.join(artifacts, 'database-selection.zip');
    const proof = JSON.parse(await fs.readFile(path.join(artifacts, 'database-proof.json'), 'utf8')) as {
      project: { id: string; name: string }; sourceInstanceId: string; sourceLicenseId: string; unicodeDescription: string; sourceAutomationCount: number;
    };
    const snapshot = JSON.parse(await fs.readFile(path.join(artifacts, 'database-snapshot-result.json'), 'utf8')) as { rows: number; nativeStateHashes: Array<{ id: string; sha256: string }> };
    const manifest = JSON.parse(zipRead(filename, 'manifest.json').toString()) as CanvasMigrationManifest;
    const target = await runtimeEnv('target');
    let context = await login(browser); let page = await context.newPage();
    const licenseIdentity = async (instanceId: string) => {
      const database = new Pool({ connectionString: target.DATABASE_URL });
      try {
        const cert = (await database.query('SELECT cert FROM license_certs WHERE instance_id=$1 ORDER BY id DESC LIMIT 1', [instanceId])).rows[0]?.cert as string;
        expect(Boolean(cert)).toBe(true);
        return JSON.parse(Buffer.from(cert.split('.')[1], 'base64url').toString()).licenseId || digest(Buffer.from(cert));
      } finally { await database.end(); }
    };
    try {
      const before = await json<{ instanceId: string; licensed: boolean; edition: string }>(await context.request.get('/api/license/status'));
      const beforeLicense = await licenseIdentity(before.instanceId);
      expect(before.licensed).toBe(true); expect(before.edition).toBe('team');
      expect(before.instanceId).not.toBe(proof.sourceInstanceId); expect(beforeLicense).not.toBe(proof.sourceLicenseId);
      const oldSession = await json<{ session: { id: string } }>(await context.request.get('/api/auth/get-session'));
      await json(await context.request.patch('/api/integrations/env', { data: { secretScope: 'system', scope: 'all',
        patches: [{ key: 'MIGRATION_TARGET_KEEP_99B4', value: 'target-private-fixture-key-99b4' }] } }));
      const stale = path.join(target.DATA, 'workspaces/target-only-99b4/stale.txt');
      await fs.mkdir(path.dirname(stale), { recursive: true }); await fs.writeFile(stale, 'Target-only file must stay in rollback backup.');
      await settings(page, 'data-migration');
      const completed = page.waitForResponse(response => /\/api\/migration\/uploads\/[^/]+\/complete$/.test(response.url()));
      await page.locator('input[type=file]').setInputFiles(filename);
      const inspection = (await (await completed).json()).inspection;
      expect(inspection.canRestore).toBe(true);
      page.once('dialog', dialog => dialog.accept('FULL_RESTORE'));
      const staged = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/migration/restore'));
      await page.getByRole('button', { name: 'Full Restore starten', exact: true }).click();
      expect((await staged).status()).toBe(200);
      await stopRuntime(); await startRuntime('target');
      const old = await (await context.request.get('/api/auth/get-session')).json();
      expect(old?.session?.id === oldSession.session.id).toBe(false);
      await page.close(); await context.close(); context = await login(browser); page = await context.newPage();
      const after = await json<{ instanceId: string; licensed: boolean; edition: string }>(await context.request.get('/api/license/status'));
      expect(after.instanceId).toBe(before.instanceId); expect(after.licensed).toBe(true); expect(after.edition).toBe('team');
      expect(await licenseIdentity(after.instanceId)).toBe(beforeLicense);
      const result = await json<{ result: { status: string; databaseRows: number; databaseTables: number } }>(await context.request.get('/api/migration/restore'));
      expect(result.result.status).toBe('completed'); expect(result.result.databaseRows).toBe(snapshot.rows); expect(result.result.databaseTables).toBeGreaterThan(100);
      const verification = new Pool({ connectionString: target.DATABASE_URL });
      try {
        for (const state of snapshot.nativeStateHashes) {
          const row = (await verification.query('SELECT yjs_state FROM collaboration_yjs_states WHERE document_id=$1', [state.id])).rows[0];
          expect(Boolean(row && Buffer.isBuffer(row.yjs_state))).toBe(true);
          expect(digest(row.yjs_state), 'Native PostgreSQL state survives the logical transfer.').toBe(state.sha256);
        }
        expect((await verification.query('SELECT count(*)::text count FROM public_file_shares')).rows[0].count).toBe('0');
        expect((await verification.query("SELECT access_token IS NULL AND refresh_token IS NULL AND id_token IS NULL cleared FROM account WHERE id='migration-oauth-fixture-99b4'")).rows[0]?.cleared).toBe(true);
        expect(Number((await verification.query('SELECT count(*)::text count FROM automation_jobs')).rows[0].count)).toBe(proof.sourceAutomationCount);
        expect((await verification.query("SELECT count(*)::text count FROM automation_jobs WHERE status='active'")).rows[0].count).toBe('0');
        expect((await verification.query('SELECT description FROM canvas_projects WHERE id=$1', [proof.project.id])).rows[0].description).toBe(proof.unicodeDescription);
      } finally { await verification.end(); }
      const projectList = await json<{ projects: Array<{ id: string; name: string }> }>(await context.request.get('/api/projects'));
      expect(projectList.projects.some(project => project.id === proof.project.id && project.name === proof.project.name)).toBe(true);
      const secret = await json<{ data: { entries: Array<{ key: string; value: string }> } }>(await context.request.get('/api/integrations/env?scope=all&secretScope=system&key=MIGRATION_TARGET_KEEP_99B4'));
      expect(secret.data.entries.find(entry => entry.key === 'MIGRATION_TARGET_KEEP_99B4')?.value === 'target-private-fixture-key-99b4').toBe(true);
      expect(await fs.stat(stale).then(() => true, () => false)).toBe(false);
      const expectedHashes = new Map(zipEntries(filename).filter(entry => !entry.directory).map(entry => [entry.path, entry.sha256]));
      let checked = 0;
      for (const file of manifest.files.filter(file => file.component === 'workspace')) {
        const mapping = [...inspection.dryRun.workspaces].sort((a, b) => b.sourcePath.length - a.sourcePath.length)
          .find(mapping => file.archivePath.startsWith(mapping.sourcePath + '/'));
        const destination = mapping.targetPath.slice(5) + file.archivePath.slice(mapping.sourcePath.length);
        expect(digest(await fs.readFile(path.join(target.DATA, destination))), destination).toBe(expectedHashes.get(file.archivePath)); checked++;
      }
      await settings(page, 'data-migration');
      await expect(page.getByTestId('migration-restore-receipt')).toContainText('PostgreSQL:');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByTestId('migration-restore-receipt').scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: path.join(artifacts, '15-postgres-restored-mobile.png') });
      await fs.writeFile(path.join(artifacts, 'database-transfer-result.json'), JSON.stringify({ rows: result.result.databaseRows,
        tables: result.result.databaseTables, filesChecked: checked, nativeStatesChecked: snapshot.nativeStateHashes.length, distinctTargetInstancePreserved: true,
        distinctTargetLicensePreserved: true, sourceProjectVisible: true, targetApiKeyPreserved: true,
        staleWorkspaceFilesRemoved: true, previousSessionInvalidated: true }, null, 2), { mode: 0o600 });
    } finally { await page.close(); await context.close(); }
  });

});
