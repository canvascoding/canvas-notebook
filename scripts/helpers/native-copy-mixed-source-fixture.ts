import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { withNativeCopyMetadataOwnerFixture } from './native-copy-metadata-owner-fixture';

type Fixture = Parameters<Parameters<typeof withNativeCopyMetadataOwnerFixture>[0]>[0];
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/** Real native Markdown, current Scene/assets, binary original and directory.
 * Setup uses the existing genuine owner/import/patch APIs. Source projections
 * are deliberately absent so a copy must consume authoritative native state. */
export async function seedNativeCopyMixedSource(h: Fixture) {
  const { resolveWorkspaceActor } = await import('../../app/lib/workspaces/context');
  const { readPostgresWorkspaceForActorOnConnection } = await import('../../app/lib/workspaces/postgres-runtime');
  const { importExcalidrawDocumentFile } = await import('../../app/lib/excalidraw-collaboration/portable-import');
  const { applyExcalidrawScenePatch } = await import('../../app/lib/excalidraw-collaboration/repository');
  const owner = await readPostgresWorkspaceForActorOnConnection(h.connection,
    resolveWorkspaceActor({ id: 'owner', role: 'admin', email: 'owner@principal.test' }), h.source.workspaceId); assert(owner);
  const suffix = randomUUID(), root = `key-mixed-${suffix}`, destinationPath = `key-copy-${suffix}`, assetId = `png-${suffix}`;
  const png = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'), Buffer.from(suffix)]);
  const note = await h.upload(`${root}/note.md`, Buffer.from(`# Note\n[Scene](/${root}/diagram.excalidraw) [Target](target.md) [PDF](manual.pdf)\n`));
  const target = await h.upload(`${root}/target.md`, Buffer.from('# Target\n'));
  const incoming = await h.upload(`${root}-incoming.md`, Buffer.from(`[Original scene](/${root}/diagram.excalidraw)\n`));
  await h.metadata(h.source, `${root}/note.md`, { title: 'API-key shared source title' });
  const pdf = Buffer.from('%PDF-1.7\n\0\xff\n%%EOF', 'binary');
  await fs.mkdir(path.join(h.source.rootPath, root, 'empty'), { recursive: true });
  await fs.writeFile(path.join(h.source.rootPath, root, 'manual.pdf'), pdf, { mode: 0o600, flag: 'wx' });
  const initial = await importExcalidrawDocumentFile({ workspace: owner,
    actor: { userId: 'owner', actorId: 'owner', actorType: 'user', sessionId: 'session-owner' }, path: `${root}/diagram.excalidraw`, content: JSON.stringify({
      type: 'excalidraw', version: 2, elements: [{ id: 'image', type: 'image', fileId: assetId, version: 1, versionNonce: 1, isDeleted: false }],
      appState: { viewBackgroundColor: '#ffffff' }, files: { [assetId]: { id: assetId, mimeType: 'image/png',
        dataURL: `data:image/png;base64,${png.toString('base64')}`, created: 123, version: 2 } } }) });
  const latest = await applyExcalidrawScenePatch({ documentId: initial.documentId, lifecycleGeneration: initial.lifecycleGeneration,
    baseSequence: initial.sceneSequence, messageId: randomUUID(), actorType: 'user', actorId: 'owner', initiatedByUserId: 'owner',
    elements: [{ id: 'latest', type: 'rectangle', version: 1, versionNonce: 7, isDeleted: false, x: 42 }] });
  for (const name of ['note.md', 'target.md', 'diagram.excalidraw']) await fs.unlink(path.join(h.source.rootPath, root, name));
  const ids = [note.documentId, target.documentId, incoming.documentId, initial.documentId];
  const sourceSnapshot = async () => ({ rows: (await h.admin.query(`
    SELECT 'native' AS kind,document_id AS id,to_jsonb(s)::text AS body,xmin::text AS xmin FROM collaboration_yjs_states s WHERE document_id=ANY($1::text[])
    UNION ALL SELECT 'scene',document_id,to_jsonb(s)::text,xmin::text FROM collaboration_excalidraw_states s WHERE document_id=ANY($1::text[])
    UNION ALL SELECT 'registry',id,to_jsonb(d)::text,xmin::text FROM collaboration_documents d WHERE id=ANY($1::text[])
    UNION ALL SELECT 'lineage',id,to_jsonb(l)::text,xmin::text FROM file_collaboration_lineages l WHERE id IN (SELECT lineage_id FROM collaboration_documents WHERE id=ANY($1::text[]))
    UNION ALL SELECT 'revision',id,to_jsonb(r)::text,xmin::text FROM file_revisions r WHERE lineage_id IN (SELECT lineage_id FROM collaboration_documents WHERE id=ANY($1::text[]))
    UNION ALL SELECT 'asset',file_id,to_jsonb(a)::text,xmin::text FROM collaboration_excalidraw_assets a WHERE workspace_id=$2 AND file_id=$3
    UNION ALL SELECT 'metadata',path,to_jsonb(m)::text,xmin::text FROM workspace_file_metadata m WHERE workspace_id=$2 AND path IN (SELECT path FROM collaboration_documents WHERE id=ANY($1::text[]))
    ORDER BY kind,id`, [ids, h.source.workspaceId, assetId])).rows,
  pdf: await fs.readFile(path.join(h.source.rootPath, root, 'manual.pdf')) });
  const blob = (workspaceId: string) => path.join(h.dataRoot, 'collaboration-assets/excalidraw', sha(workspaceId).slice(0, 32), sha(png));
  return { operationId: randomUUID(), root, destinationPath, assetId, png, pdf, ids, initial, latest,
    selections: [{ sourcePath: root, destinationPath }], sourceBefore: await sourceSnapshot(), sourceSnapshot, blob };
}
