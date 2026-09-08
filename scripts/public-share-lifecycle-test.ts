import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

import { parsePublicSharePolicy, requirePublicShareBody } from '../app/lib/public-sharing/share-policy-input';

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'canvas-share-lifecycle-'));
  process.env.DATA = tempRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  process.env.CANVAS_DEPLOYMENT_MODE = 'standalone';
  process.env.BETTER_AUTH_BASE_URL = 'http://localhost';
  process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
  const workspaceRoot = path.join(tempRoot, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  const { db, openDb } = await import('../app/lib/db');
  const { user, publicFileShares } = await import('../app/lib/db/schema');
  const service = await import('../app/lib/public-sharing/public-file-shares');
  const { createPostgresDrizzle, runPostgresMigrations } = await import('../app/lib/db/postgres');
  const postgres = new PGlite();
  const original = { select: db.select, insert: db.insert, update: db.update };
  try {
    assert.deepEqual(parsePublicSharePolicy({}), {});
    assert.deepEqual(parsePublicSharePolicy({ expiresAt: null }), { expiresAt: null });
    for (const value of [[], null, 1, 'bad']) assert.throws(() => requirePublicShareBody(value));
    for (const body of [
      { expiresAt: 'invalid' }, { expiresAt: '2000-01-01T00:00:00Z' },
      { expiresInDays: -1 }, { expiresInDays: '7garbage' }, { expiresInDays: 1.5 },
      { expiresInDays: 366 }, { expiresInDays: 7, expiresAt: null }, { securityMode: 'bogus' },
    ]) assert.throws(() => parsePublicSharePolicy(body));

    await runPostgresMigrations(postgres as unknown as Parameters<typeof runPostgresMigrations>[0]);
    const pgClient = {
      query: async (query: string | { text: string; rowMode?: string }, values?: unknown[]) => {
        const result = await postgres.query<Record<string, unknown>>(typeof query === 'string' ? query : query.text, values);
        return {
          ...result, rowCount: result.affectedRows ?? result.rows.length,
          rows: typeof query !== 'string' && query.rowMode === 'array'
            ? result.rows.map((row) => result.fields.map((field) => row[field.name])) : result.rows,
        };
      },
    };
    const pg = createPostgresDrizzle(pgClient as unknown as Parameters<typeof createPostgresDrizzle>[0]);
    for (const provider of ['sqlite', 'postgres'] as const) {
      if (provider === 'postgres') {
        Object.assign(db, { select: pg.select.bind(pg), insert: pg.insert.bind(pg), update: pg.update.bind(pg) });
      }
      await db.insert(user).values({ id: 'share-owner', name: 'Owner', email: 'owner@example.test', emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(user).values({ id: 'share-other', name: 'Other', email: 'other@example.test', emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
      const file = `${provider}.md`;
      await writeFile(path.join(workspaceRoot, file), '# Shared\n');
      const expiry = new Date(Date.now() + 86_400_000);
      const creations = await Promise.all(Array.from({ length: 24 }, () => service.createPublicFileShares({
        paths: [file], createdByUserId: 'share-owner', expiresAt: expiry,
      })));
      assert.ok(creations.every((result) => result.shares.length === 1 && result.skipped.length === 0), JSON.stringify(creations));
      assert.equal(new Set(creations.flatMap((result) => result.shares.map((share) => share.id))).size, 1);
      const share = creations[0].shares[0];
      const token = decodeURIComponent(share.publicPath.split('/')[3]);
      const fileRoute = await import('../app/public/files/[token]/[...filename]/route');
      const fileParams = { params: Promise.resolve({ token, filename: [file] }) };
      const head = await fileRoute.HEAD(new NextRequest(`http://localhost${share.publicPath}`, { method: 'HEAD' }), fileParams);
      assert.equal(head.status, 200);
      const [afterHead] = await db.select().from(publicFileShares).where(eq(publicFileShares.id, share.id));
      assert.equal(afterHead.accessCount, 0, 'HEAD requests must not count as views');
      const wrongPreview = await fileRoute.GET(new NextRequest('http://localhost/file', { headers: { 'sec-fetch-dest': 'document' } }), {
        params: Promise.resolve({ token, filename: ['wrong.md'] }),
      });
      assert.equal(wrongPreview.status, 404);
      await db.update(publicFileShares).set({ accessCount: 0 }).where(eq(publicFileShares.id, share.id));
      await db.update(publicFileShares).set({ shortCode: null }).where(eq(publicFileShares.id, share.id));
      const accesses = await Promise.all(Array.from({ length: 32 }, () => service.resolvePublicShareToken(token)));
      assert.ok(accesses.every((result) => result.ok));
      assert.equal(new Set(accesses.map((result) => result.ok ? result.share.shortCode : null)).size, 1);
      let [row] = await db.select().from(publicFileShares).where(eq(publicFileShares.id, share.id));
      assert.equal(row.accessCount, 32, `${provider}: no lost counter increments`);
      assert.equal(row.policyRevision, share.policyRevision, 'Reads must not invalidate settings edits');
      await assert.rejects(db.insert(publicFileShares).values({ ...row, id: 'duplicate', token: 'duplicate', tokenHash: 'duplicate', shortCode: 'DUP123' }).returning());

      const sqliteConnection = provider === 'sqlite' ? await openDb() : null;
      const migrationQuery = (statement: string) => sqliteConnection ? sqliteConnection.run(statement) : postgres.query(statement);
      try {
        await migrationQuery('DROP INDEX idx_public_file_shares_active_path');
        await db.insert(publicFileShares).values({ ...row, id: 'legacy-duplicate', token: 'legacy-duplicate', tokenHash: 'legacy-duplicate', shortCode: 'Dup234',
          workspaceId: 'legacy-personal-workspace', createdAt: new Date(row.createdAt.getTime() + 1000) });
        const { PUBLIC_SHARE_UNIQUENESS_STATEMENTS } = await import('../app/lib/db/public-share-migration');
        for (const statement of PUBLIC_SHARE_UNIQUENESS_STATEMENTS) await migrationQuery(statement);
        const [duplicate] = await db.select().from(publicFileShares).where(eq(publicFileShares.id, 'legacy-duplicate'));
        assert.equal(duplicate.status, 'revoked');
        assert.equal(duplicate.revokedReason, 'duplicate_active_link');
        assert.equal((await service.resolvePublicShareToken(token, { recordAccess: false })).ok, true);
      } finally {
        await sqliteConnection?.close();
      }

      const extended = new Date(Date.now() + 7 * 86_400_000);
      const repeated = await service.createPublicFileShares({ paths: [file], createdByUserId: 'share-owner', expiresAt: extended });
      assert.equal(repeated.shares[0].id, share.id);
      assert.equal(repeated.shares[0].expiresAt?.slice(0, 19), extended.toISOString().slice(0, 19));
      const updates = await Promise.allSettled(Array.from({ length: 16 }, () => service.updatePublicFileShare({
        id: share.id, userId: 'share-owner', expectedPolicyRevision: repeated.shares[0].policyRevision, expiresAt: null,
      })));
      assert.equal(updates.filter((result) => result.status === 'fulfilled').length, 1);
      for (const result of updates) if (result.status === 'rejected') assert.equal(result.reason.status, 409);
      [row] = await db.select().from(publicFileShares).where(eq(publicFileShares.id, share.id));
      assert.equal(row.expiresAt, null);
      await assert.rejects(service.updatePublicFileShare({ id: share.id, userId: 'share-other', expectedPolicyRevision: row.policyRevision, expiresAt: expiry }), { status: 403 });
      await assert.rejects(service.updatePublicFileShare({ id: share.id, userId: 'share-owner', expectedPolicyRevision: 1, expiresAt: null }), { status: 409 });

      const hidden = path.join(workspaceRoot, `${file}.hidden`);
      await rename(path.join(workspaceRoot, file), hidden);
      assert.equal((await service.resolvePublicShareToken(token)).ok, false);
      await rename(hidden, path.join(workspaceRoot, file));
      assert.equal((await service.resolvePublicShareToken(token)).ok, true, 'Transient absence must recover for the original file');
      await rename(path.join(workspaceRoot, file), hidden);
      await writeFile(path.join(workspaceRoot, file), '# Different file\n');
      assert.equal((await service.resolvePublicShareToken(token)).ok, false, 'Reads must not bind a different inode');
      await service.syncPublicSharesAfterWrite([file]);
      assert.equal((await service.resolvePublicShareToken(token)).ok, true, 'Authorized writes can rebind atomic replacements');
      await Promise.all([
        ...Array.from({ length: 16 }, () => service.resolvePublicShareToken(token)),
        service.revokePublicFileShare({ id: share.id, userId: 'share-owner' }),
      ]);
      assert.equal((await service.resolvePublicShareToken(token)).ok, false);
      [row] = await db.select().from(publicFileShares).where(eq(publicFileShares.id, share.id));
      assert.equal(row.status, 'revoked');
      await service.syncPublicSharesAfterWrite([file]);
      assert.equal((await service.resolvePublicShareToken(token)).ok, false, 'A late write hook must not resurrect a revoked link');
      const replacement = await service.createPublicFileShares({ paths: [file], createdByUserId: 'share-owner' });
      assert.notEqual(replacement.shares[0].publicPath, share.publicPath);
      await db.update(publicFileShares).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(publicFileShares.id, replacement.shares[0].id));
      const expiredToken = replacement.shares[0].publicPath.split('/')[3];
      assert.equal((await service.resolvePublicShareToken(expiredToken)).ok, false);
      const afterExpiry = await service.createPublicFileShares({ paths: [file], createdByUserId: 'share-owner' });
      assert.equal(afterExpiry.shares.length, 1);
      assert.notEqual(afterExpiry.shares[0].publicPath, replacement.shares[0].publicPath);
      await service.syncPublicSharesAfterMove(file, `${file}.moved`);
      assert.equal((await service.resolvePublicShareToken(afterExpiry.shares[0].publicPath.split('/')[3])).ok, false);
      const largeFile = `${provider}-large.txt`;
      await writeFile(path.join(workspaceRoot, largeFile), Buffer.alloc(6 * 1024 * 1024, 65));
      const largeShare = await service.createPublicFileShares({ paths: [largeFile], createdByUserId: 'share-owner' });
      const largeHead = await fileRoute.HEAD(new NextRequest('http://localhost/large', { method: 'HEAD' }), {
        params: Promise.resolve({ token: largeShare.shares[0].publicPath.split('/')[3], filename: [largeFile] }),
      });
      assert.equal(largeHead.status, 200, 'Text above the preview limit remains downloadable');
      assert.equal(largeHead.headers.get('content-length'), String(6 * 1024 * 1024));
      console.log(`public-share-lifecycle-test: ${provider} ok`);
    }
    const { limitPublicExport } = await import('../app/lib/public-sharing/public-export-limit');
    let limited: ReturnType<typeof limitPublicExport> | undefined;
    for (let index = 0; index < 11; index += 1) {
      limited = limitPublicExport(new NextRequest('http://localhost/public/pdf', { headers: { cookie: `better-auth.session_token=fake-${index}` } }), 'markdown-pdf');
    }
    assert.equal(limited?.ok, false, 'Invented cookies cannot bypass the public renderer budget');
    if (limited && !limited.ok) assert.equal(limited.response.status, 429);
  } finally {
    Object.assign(db, original);
    await postgres.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
