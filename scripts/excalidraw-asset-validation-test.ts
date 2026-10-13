import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { closeDatabaseConnections, openDb } from '@/app/lib/db';
import { createPostgresPool, runPostgresMigrations } from '@/app/lib/db/postgres';
import { resolveDataDir } from '@/app/lib/db/provider';
import { assertPortableExcalidrawAssetBindings, ExcalidrawAssetConflictError,
  importPortableExcalidrawAssets, loadExcalidrawAsset, storeExcalidrawAsset,
  validatePortableExcalidrawAssets } from '@/app/lib/excalidraw-collaboration/assets';
import { serializePortableExcalidrawScene } from '@/app/lib/excalidraw-collaboration/checkpoint';
import { EXCALIDRAW_ASSET_MAX_BYTES, EXCALIDRAW_PORTABLE_MAX_BYTES } from '@/app/lib/excalidraw-collaboration/limits';
import type { PersistedExcalidrawScene } from '@/app/lib/excalidraw-collaboration/repository';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const otherPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const encodedAsset = (id: string, bytes = png) => ({ id, mimeType: 'image/png',
  dataURL: `data:image/png;base64,${bytes.toString('base64')}`, version: 1, created: 42 });
const portable = (files: Record<string, unknown>) => JSON.stringify({ type: 'excalidraw', elements: [], files });
const assetDirectory = (workspaceId: string) => path.join(resolveDataDir(), 'collaboration-assets', 'excalidraw',
  createHash('sha256').update(workspaceId).digest('hex').slice(0, 32));

async function assetRows(workspaceId: string) {
  const database = await openDb();
  try { return await database.all('SELECT file_id, content_sha256 FROM collaboration_excalidraw_assets WHERE workspace_id = $1', [workspaceId]); }
  finally { await database.close(); }
}

async function main() {
  assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  assert.equal(process.env.NODE_ENV, 'test');
  assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/canvas_(?:editor|excalidraw)_test_[a-f0-9]{16}$/u,
    'Run only against the existing private disposable PostgreSQL wrapper.');
  const migrations = createPostgresPool();
  try { await runPostgresMigrations(migrations); } finally { await migrations.end(); }
  const scopes = Array.from({ length: 3 }, () => `asset-validation-${randomUUID()}`);
  try {
    const invalidSecond = portable({ prefix: encodedAsset('prefix'), invalid: encodedAsset('invalid', Buffer.from('not a PNG')) });
    await assert.rejects(importPortableExcalidrawAssets({ workspaceId: scopes[0], content: invalidSecond }), /PNG signature/u);
    assert.deepEqual(await assetRows(scopes[0]), [], 'A late invalid image must not leave earlier metadata.');
    await assert.rejects(fs.access(assetDirectory(scopes[0])), { code: 'ENOENT' }, 'Pure batch validation must run before any image bytes are written.');

    const existing = await storeExcalidrawAsset({ workspaceId: scopes[1], fileId: 'existing', mimeType: 'image/png', data: png });
    const beforeFiles = await fs.readdir(assetDirectory(scopes[1]));
    const conflictingBatch = portable({ prefix: encodedAsset('prefix', otherPng), existing: encodedAsset('existing', otherPng) });
    const validated = validatePortableExcalidrawAssets(conflictingBatch);
    await assert.rejects(assertPortableExcalidrawAssetBindings(scopes[1], validated), ExcalidrawAssetConflictError);
    await assert.rejects(importPortableExcalidrawAssets({ workspaceId: scopes[1], content: conflictingBatch }), ExcalidrawAssetConflictError);
    assert.deepEqual(await assetRows(scopes[1]), [{ file_id: 'existing', content_sha256: existing.contentHash }],
      'A later ID conflict must not bind the earlier valid prefix asset.');
    assert.deepEqual(await fs.readdir(assetDirectory(scopes[1])), beforeFiles, 'Binding preflight must reject before publishing any new image blob.');
    assert.deepEqual((await loadExcalidrawAsset({ workspaceId: scopes[1], fileId: 'existing' }))?.data, png);

    const racing = await Promise.allSettled([png, otherPng].map(data => storeExcalidrawAsset({
      workspaceId: scopes[2], fileId: 'race', mimeType: 'image/png', data })));
    const winners = racing.filter(result => result.status === 'fulfilled');
    const losers = racing.filter(result => result.status === 'rejected');
    assert.equal(winners.length, 1, 'Different bytes under one ID cannot both be acknowledged.');
    assert.equal(losers.length, 1);
    assert(losers[0].status === 'rejected' && losers[0].reason instanceof ExcalidrawAssetConflictError);
    const winner = winners[0];
    assert(winner.status === 'fulfilled');
    assert.equal((await loadExcalidrawAsset({ workspaceId: scopes[2], fileId: 'race' }))?.metadata.contentHash, winner.value.contentHash);

    for (const files of [
      { invalid: { ...encodedAsset('invalid'), version: 0 } },
      { invalid: { ...encodedAsset('invalid'), created: -1 } },
      { invalid: { ...encodedAsset('invalid'), id: 'mismatch' } },
      { invalid: { ...encodedAsset('invalid'), mimeType: 'image/jpeg' } },
      { invalid: { ...encodedAsset('invalid'), dataURL: 'data:image/png;base64,ab=c' } },
      { '../unsafe': encodedAsset('../unsafe') },
      { invalid: { ...encodedAsset('invalid'), dataURL: undefined } },
    ]) assert.throws(() => validatePortableExcalidrawAssets(portable(files)));
    assert.throws(() => validatePortableExcalidrawAssets(' '.repeat(EXCALIDRAW_PORTABLE_MAX_BYTES + 1)),
      (error: unknown) => (error as { status?: number }).status === 413, 'The shared portable byte limit must run before JSON parsing.');
    assert.throws(() => validatePortableExcalidrawAssets(portable({ oversized: {
      id: 'oversized', dataURL: `data:image/png;base64,${'A'.repeat(Math.ceil(EXCALIDRAW_ASSET_MAX_BYTES / 3) * 4 + 4)}` } })), /20 MiB/u);

    // Nonexistent asset IDs prove the serializer rejects its encoded byte budget
    // before attempting to load any of these potentially large image buffers.
    const oversizedState = { workspaceId: scopes[0], elements: [], appState: {}, assets: Array.from({ length: 2 }, (_, index) => ({
      fileId: `never-loaded-${index}`, contentHash: '0'.repeat(64), mimeType: 'image/png',
      sizeBytes: EXCALIDRAW_ASSET_MAX_BYTES, version: 1, createdAt: 42 })) } as PersistedExcalidrawScene;
    await assert.rejects(serializePortableExcalidrawScene(oversizedState),
      (error: unknown) => (error as { code?: string }).code === 'EXCALIDRAW_CHECKPOINT_TOO_LARGE');
    console.log('Excalidraw full-batch asset validation, immutable ID conflicts, concurrent CAS and early portable limits verified.');
  } finally {
    const database = await openDb();
    try { await database.run('DELETE FROM collaboration_excalidraw_assets WHERE workspace_id = ANY($1::text[])', [scopes]); }
    finally { await database.close(); }
    await Promise.all(scopes.map(scope => fs.rm(assetDirectory(scope), { recursive: true, force: true })));
  }
}

main().finally(() => closeDatabaseConnections()).catch(error => { console.error(error); process.exitCode = 1; });
