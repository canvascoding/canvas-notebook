import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { NextRequest } from 'next/server';

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'canvas-share-snapshot-'));
  process.env.DATA = tempRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'postgres';
  process.env.DATABASE_URL = 'postgresql://snapshot-test.invalid/canvas';
  process.env.BETTER_AUTH_BASE_URL = 'http://localhost';
  process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
  const postgres = new PGlite();
  // Exercise the normal Drizzle and openDb paths against the embedded Postgres
  // adapter, with no network connection or container required.
  const query = async (input: string | { text: string; rowMode?: string }, values?: unknown[]) => {
    const result = await postgres.query<Record<string, unknown>>(typeof input === 'string' ? input : input.text, values);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length,
      rows: typeof input !== 'string' && input.rowMode === 'array'
        ? result.rows.map((row) => result.fields.map((field) => row[field.name])) : result.rows };
  };
  const original = { query: Pool.prototype.query, connect: Pool.prototype.connect };
  Object.defineProperty(Pool.prototype, 'query', { configurable: true, writable: true, value: query });
  Object.defineProperty(Pool.prototype, 'connect', { configurable: true, writable: true, value: async () => ({ query, release() {} }) });
  let uninstall: (() => void) | undefined;
  try {
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    await runPostgresMigrations(postgres as unknown as Parameters<typeof runPostgresMigrations>[0]);
    const { db } = await import('../app/lib/db');
    const { user } = await import('../app/lib/db/schema');
    await db.insert(user).values({ id: 'owner', name: 'Owner', email: 'owner@example.test', emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    const { createLegacyPersonalWorkspaceContext } = await import('../app/lib/workspaces/context');
    const workspace = createLegacyPersonalWorkspaceContext({ userId: 'owner', role: 'admin' });
    await mkdir(path.join(workspace.rootPath, 'images'), { recursive: true });
    await writeFile(path.join(workspace.rootPath, 'notes.md'), '# Disk checkpoint\n');
    await writeFile(path.join(workspace.rootPath, 'images', 'live.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    const sharing = await import('../app/lib/public-sharing/public-file-shares');
    const created = await sharing.createPublicFileShares({ paths: ['notes.md'], createdByUserId: 'owner', workspace });
    assert.equal(created.shares.length, 1, JSON.stringify(created.skipped));
    const token = created.shares[0].publicPath.split('/')[3];
    const resolved = await sharing.resolvePublicShareToken(token, { recordAccess: false });
    assert.ok(resolved.ok);
    const { getFileCollaborationState } = await import('../app/lib/files/collaboration-policy');
    const state = await getFileCollaborationState({ workspace, path: 'notes.md', ensureDocument: true });
    assert.ok(state.document);
    const { ensureCollaborationState } = await import('../app/lib/collaboration/persistence');
    await ensureCollaborationState({ documentId: state.document.id, workspaceId: workspace.workspaceId, organizationId: null,
      path: 'notes.md', representation: 'tiptap_xml', initialContent: '# Persisted edit\n' });
    const { readPublicShareText } = await import('../app/lib/public-sharing/public-share-text');
    assert.match(await readPublicShareText(resolved), /Persisted edit/);
    const { createRichMarkdownYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { installCollaborationDocumentReader } = await import('../app/lib/collaboration/document-access');
    const live = createRichMarkdownYDoc('# Live edit\n\n![image](images/live.png)\n');
    uninstall = installCollaborationDocumentReader(async (documentId, workspaceId, read) => {
      assert.equal(documentId, state.document!.id);
      assert.equal(workspaceId, workspace.workspaceId);
      return read(live);
    });
    const content = await readPublicShareText(resolved);
    assert.match(content, /Live edit/);
    assert.equal(await readFile(path.join(workspace.rootPath, 'notes.md'), 'utf8'), '# Disk checkpoint\n');
    const { publicShareFileResponse } = await import('../app/lib/public-sharing/public-file-response');
    const download = await publicShareFileResponse(new NextRequest('http://localhost/download?download=1'), resolved, 'GET');
    assert.equal(await download.text(), content);
    assert.equal(download.headers.get('cache-control'), 'no-store');
    const range = await publicShareFileResponse(new NextRequest('http://localhost/download', { headers: { range: 'bytes=0-3' } }), resolved, 'GET');
    assert.equal(range.status, 206);
    assert.equal(await range.text(), content.slice(0, 4));
    const assets = await import('../app/public/markdown-assets/[token]/[...assetPath]/route');
    const image = await assets.GET(new NextRequest('http://localhost/image'), { params: Promise.resolve({ token, assetPath: ['images', 'live.png'] }) });
    assert.equal(image.status, 200, 'Images in uncheckpointed live Markdown are available');
    await image.arrayBuffer();
    const { getPublicMarkdownExport } = await import('../app/lib/public-sharing/public-markdown-export');
    const exported = await getPublicMarkdownExport(token);
    assert.ok(exported.ok);
    assert.match(exported.html, /Live edit/);
    assert.doesNotMatch(exported.html, /Disk checkpoint/);
    const { replaceRichMarkdownInYDoc } = await import('../app/lib/collaboration/markdown-state');
    replaceRichMarkdownInYDoc(live, '# Next live edit\n');
    const nextExport = await getPublicMarkdownExport(token);
    assert.ok(nextExport.ok);
    assert.match(nextExport.html, /Next live edit/, 'The export cache follows live content even without a filesystem change');
    uninstall();
    uninstall = installCollaborationDocumentReader(async (_documentId, _workspaceId, read) => {
      await sharing.revokePublicFileShare({ id: created.shares[0].id, userId: 'owner', workspace });
      return read(live);
    });
    await assert.rejects(readPublicShareText(resolved), /no longer available/);
    live.destroy();
    console.log('public-share-snapshot-test: persisted state, live state, downloads, assets, export and concurrent revocation ok');
  } finally {
    uninstall?.();
    Object.assign(Pool.prototype, original);
    await postgres.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
