import assert from 'node:assert/strict';

import { closeDatabaseConnections } from '@/app/lib/db';
import { createPostgresPool, runPostgresMigrations } from '@/app/lib/db/postgres';
import {
  importPortableExcalidrawAssets,
  loadExcalidrawAsset,
  storeExcalidrawAsset,
  validateExcalidrawAssetMetadata,
} from '@/app/lib/excalidraw-collaboration/assets';
import { serializePortableExcalidrawScene } from '@/app/lib/excalidraw-collaboration/checkpoint';
import { ensureExcalidrawScene } from '@/app/lib/excalidraw-collaboration/repository';

async function main() {
  assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  const migrationPool = createPostgresPool();
  await runPostgresMigrations(migrationPool);
  await migrationPool.end();
  const suffix = `${Date.now()}-${process.pid}`;
  const workspaceId = `asset-workspace-${suffix}`;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

  const first = await storeExcalidrawAsset({ workspaceId, fileId: 'image-a', mimeType: 'image/png', data: png, version: 1 });
  const duplicate = await storeExcalidrawAsset({ workspaceId, fileId: 'image-b', mimeType: 'image/png', data: png, version: 1 });
  assert.equal(first.contentHash, duplicate.contentHash, 'Equal assets must deduplicate by content hash.');
  assert.deepEqual((await loadExcalidrawAsset({ workspaceId, fileId: 'image-a' }))?.data, png);
  assert.equal(await loadExcalidrawAsset({ workspaceId: 'foreign-workspace', fileId: 'image-a' }), null, 'Assets must be workspace isolated.');
  assert.deepEqual(await validateExcalidrawAssetMetadata(workspaceId, [first]), [first]);
  await assert.rejects(validateExcalidrawAssetMetadata('foreign-workspace', [first]), /unavailable/u);
  const sanitizedSvgMetadata = await storeExcalidrawAsset({
    workspaceId,
    fileId: 'active-svg',
    mimeType: 'image/svg+xml',
    data: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/>${' '.repeat(8_192)}<script>alert(1)</script><circle onload="alert(1)" r="5"/></svg>`),
  });
  const sanitizedSvg = await loadExcalidrawAsset({ workspaceId, fileId: sanitizedSvgMetadata.fileId });
  assert(sanitizedSvg);
  assert.doesNotMatch(sanitizedSvg.data.toString('utf8'), /<script|\bonload\s*=/iu);
  assert.match(sanitizedSvg.data.toString('utf8'), /<rect/u);
  assert.match(sanitizedSvg.data.toString('utf8'), /<circle/u);
  await assert.rejects(
    storeExcalidrawAsset({ workspaceId, fileId: 'fake-png', mimeType: 'image/png', data: Buffer.from('not-a-png') }),
    /signature/u,
  );

  const imported = await importPortableExcalidrawAssets({
    workspaceId,
    content: JSON.stringify({ files: { portable: { id: 'portable', mimeType: 'image/png', dataURL: `data:image/png;base64,${png.toString('base64')}`, version: 2, created: 10 } } }),
  });
  assert.equal(imported.length, 1);
  const state = await ensureExcalidrawScene({
    documentId: `asset-document-${suffix}`,
    workspaceId,
    organizationId: null,
    path: 'assets.excalidraw',
    initialContent: JSON.stringify({ type: 'excalidraw', elements: [], appState: {} }),
    initialAssets: [first, imported[0]],
  });
  const portable = JSON.parse(await serializePortableExcalidrawScene(state)) as { files: Record<string, { dataURL: string }> };
  assert.match(portable.files['image-a'].dataURL, /^data:image\/png;base64,/u);
  assert.match(portable.files.portable.dataURL, /^data:image\/png;base64,/u);
  console.log(JSON.stringify({ success: true, deduplicatedHash: first.contentHash, portableAssets: Object.keys(portable.files).length }));
}

void main().finally(closeDatabaseConnections);
