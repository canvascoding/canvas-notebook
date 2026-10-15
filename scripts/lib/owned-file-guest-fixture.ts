/** Test-only: new UUID fixtures inside the original owned Yjs runtime only. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { getSchema } from '@tiptap/core';
import { generateUniqueIds } from '@tiptap/extension-unique-id';
import * as Y from 'yjs';
import { CollaborationBlockTree } from '../../app/lib/collaboration/block-tree';
import { readRichDocumentJson } from '../../app/lib/collaboration/rich-document';
import { createRichMarkdownManager, richMarkdownCodecExtensions } from '../../app/lib/markdown/rich-markdown-codec';
import { equivalentRichDocument } from '../../app/lib/markdown/core/equivalence';
import { assertDatabaseOwnership, requireOwnedYjsQaTarget, type OwnedYjsReceipt } from './owned-yjs-authority-qa';

const nativeProjectionFixtures = new WeakMap<object, {
  workspaceId: string; path: string; documentId: string; lineageId: string; rootPath: string;
  projection: Buffer; identity: Stats; yjsState: Buffer; stateVector: Buffer;
}>();

export function assertOwnedFileGuestFixturePath(filePath: string, receipt: OwnedYjsReceipt): void {
  const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
  assert(new RegExp(`^(?:guest-owned-${receipt.nonce}-${uuid}\\.md| guest-owned-${receipt.nonce}-${uuid}\\.bin )$`, 'u').test(filePath));
}

export async function withOwnedFileGuestFixtureDatabase<T>(receipt: OwnedYjsReceipt, operation: (client: Client) => Promise<T>): Promise<T> {
  const url = new URL(process.env.DATABASE_URL!);
  assert.equal(url.pathname, `/${receipt.databaseName}`);
  const client = new Client({ connectionString: url.href, connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000, query_timeout: 10_000 });
  try {
    await client.connect(); await client.query('BEGIN');
    const identity = (await client.query(`SELECT current_database() AS name,d.oid::text,pg_get_userbyid(d.datdba) AS owner,
      current_user AS role,shobj_description(d.oid,'pg_database') AS marker FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
    assertDatabaseOwnership(receipt, identity);
    const result = await operation(client);
    await client.query('COMMIT'); return result;
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { await client.end(); }
}

export async function ownedFileGuestFixtureWorkspace(workspaceId: string) {
  const receipt = await requireOwnedYjsQaTarget();
  assert.equal(receipt.activeSpec, 'tests/editor-guest-collaboration.spec.ts');
  assert(receipt.selectedSpecs.includes(receipt.activeSpec)); assert(receipt.actorId);
  const workspace = await withOwnedFileGuestFixtureDatabase(receipt, async client => {
    const row = (await client.query(`SELECT w.id,w.organization_id,w.type,w.root_relative_path,w.status,
      o.owner_user_id AS organization_owner,u.id AS actor_id,u.email,u.banned FROM canvas_workspaces w
      JOIN canvas_organization_settings o ON o.organization_id=w.organization_id JOIN "user" u ON u.id=o.owner_user_id
      WHERE w.id=$1`, [workspaceId])).rows[0];
    assert(row && row.id === workspaceId && row.organization_id === process.env.CANVAS_ORGANIZATION_ID
      && row.type === 'organization' && row.status === 'active' && row.organization_owner === receipt.actorId
      && row.actor_id === receipt.actorId && row.email === process.env.TEST_LOGIN_EMAIL && !Number(row.banned));
    assert(typeof row.root_relative_path === 'string' && row.root_relative_path.length > 0
      && !path.isAbsolute(row.root_relative_path) && !row.root_relative_path.split(/[\\/]/u).some((part: string) => !part || part === '.' || part === '..'));
    return { id: workspaceId, organizationId: String(row.organization_id), type: 'organization' as const,
      rootPath: path.resolve(receipt.dataRoot, row.root_relative_path) };
  });
  assert(workspace.rootPath.startsWith(`${receipt.dataRoot}${path.sep}`));
  assert.equal(await fs.realpath(workspace.rootPath), workspace.rootPath);
  const root = await fs.lstat(workspace.rootPath);
  assert(root.isDirectory() && !root.isSymbolicLink() && root.uid === process.getuid?.());
  return { receipt, workspace };
}

export async function seedOwnedFileGuestFixture(workspaceId: string, kind: 'physical_markdown' | 'native_table') {
  const { receipt, workspace } = await ownedFileGuestFixtureWorkspace(workspaceId);
  const stem = `guest-owned-${receipt.nonce}-${randomUUID()}`;
  const filePath = kind === 'physical_markdown' ? `${stem}.md` : ` ${stem}.bin `;
  assertOwnedFileGuestFixturePath(filePath, receipt);
  await withOwnedFileGuestFixtureDatabase(receipt, async client => {
    assert.equal(Number((await client.query(`SELECT count(*) AS count FROM collaboration_documents WHERE workspace_id=$1 AND path=$2`, [workspaceId, filePath])).rows[0].count), 0);
    assert.equal(Number((await client.query(`SELECT count(*) AS count FROM file_collaboration_lineages WHERE workspace_id=$1 AND path=$2`, [workspaceId, filePath])).rows[0].count), 0);
  });
  if (kind === 'physical_markdown') {
    await fs.writeFile(path.join(workspace.rootPath, filePath), 'Physical guest paragraph\n\nNormal owner paragraph\n', { flag: 'wx', mode: 0o600 });
    return { filePath, workspaceId, kind, documentId: null, assetPath: null, unapprovedAssetPath: null };
  }
  const assetPath = `${stem}.png`, unapprovedAssetPath = `${stem}-unapproved.png`;
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1kAAAAASUVORK5CYII=', 'base64');
  await fs.writeFile(path.join(workspace.rootPath, assetPath), image, { flag: 'wx', mode: 0o600 });
  await fs.writeFile(path.join(workspace.rootPath, unapprovedAssetPath), image, { flag: 'wx', mode: 0o600 });
  // The current FileTree lists physical entries only. This deliberately stale,
  // non-authoritative projection enables actual People UI selection; it is
  // removed after UI creation before any Guest read/edit is exercised.
  const projection = Buffer.from('# Deliberately stale owned fixture projection\n');
  const projectionPath = path.join(workspace.rootPath, filePath);
  await fs.writeFile(projectionPath, projection, { flag: 'wx', mode: 0o600 });
  const identity = await fs.lstat(projectionPath);
  const extensions = richMarkdownCodecExtensions(), schema = getSchema(extensions), manager = createRichMarkdownManager();
  const doc = new Y.Doc(), documentId = `guest-native-${randomUUID()}`, lineageId = `guest-lineage-${randomUUID()}`;
  try {
    const tree = CollaborationBlockTree.create(doc, schema.nodeFromJSON(generateUniqueIds(manager.parse(
      `| Native width |\n| --- |\n| Preserved cell |\n\nNative guest paragraph\n\n![Approved fixture image](${assetPath})`,
    ), extensions)));
    for (const record of tree.records.values()) if (['tableCell', 'tableHeader'].includes((record.get('shape') as { type: string }).type)) {
      (record.get('attributes') as Y.Map<unknown>).set('colwidth', [120]);
    }
    const json = readRichDocumentJson(doc);
    assert.equal(equivalentRichDocument(json, schema.nodeFromJSON(manager.parse(manager.serialize(json))).toJSON()), false,
      'The actual native column width must be absent from a Markdown round trip.');
    const bytes = Buffer.from(Y.encodeStateAsUpdate(doc)), vector = Buffer.from(Y.encodeStateVector(doc)), now = Date.now();
    await withOwnedFileGuestFixtureDatabase(receipt, async client => {
      await client.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
        VALUES($1,$2,'organization',$3,$4,'active',$5)`, [lineageId,workspaceId,workspace.organizationId,filePath,now]);
      await client.query(`INSERT INTO collaboration_documents(id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,
        state_version,yjs_state_lifecycle,status,created_at,updated_at) VALUES($1,$2,$3,'organization',$4,$5,'yjs',1,'initialized','active',$6,$6)`,
      [documentId,lineageId,workspaceId,workspace.organizationId,filePath,now]);
      await client.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,
        yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence,checkpointed_at,canonical_hash,serialized_hash,newline_style,has_bom,degraded,status)
        VALUES($1,$2,$3,$4,'tiptap_blocks',1,1,$5,$6,1,$7,0,NULL,NULL,NULL,'lf',0,0,'active')`,
      [documentId,workspaceId,workspace.organizationId,filePath,bytes,vector,now]);
    });
    const fixture = { filePath, workspaceId, kind, documentId, assetPath, unapprovedAssetPath };
    nativeProjectionFixtures.set(fixture, { workspaceId, path: filePath, documentId, lineageId,
      rootPath: workspace.rootPath, projection, identity, yjsState: bytes, stateVector: vector });
    return fixture;
  } finally { doc.destroy(); }
}

/** Remove only our exact projection, after proving UI creation preserved the original native state. */
export async function removeOwnedFileGuestFixtureProjection(fixture: { workspaceId: string; filePath: string; documentId: string | null }): Promise<void> {
  const expected = nativeProjectionFixtures.get(fixture);
  assert(expected, 'Only the exact native fixture created by this helper may lose its projection.');
  const { receipt, workspace } = await ownedFileGuestFixtureWorkspace(fixture.workspaceId);
  assertOwnedFileGuestFixturePath(fixture.filePath, receipt);
  assert.equal(fixture.workspaceId, expected.workspaceId); assert.equal(fixture.filePath, expected.path);
  assert.equal(fixture.documentId, expected.documentId); assert.equal(workspace.rootPath, expected.rootPath);
  const fullPath = path.join(workspace.rootPath, fixture.filePath);
  const handle = await fs.open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const assertOriginalIdentity = (actual: Stats) => {
      assert(actual.isFile() && !actual.isSymbolicLink() && actual.nlink === 1 && actual.uid === process.getuid?.());
      for (const key of ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'] as const) {
        assert.equal(actual[key], expected.identity[key], `Owned projection ${key} changed.`);
      }
    };
    assertOriginalIdentity(await handle.stat());
    assert.deepEqual(await handle.readFile(), expected.projection);
    await withOwnedFileGuestFixtureDatabase(receipt, async database => {
      const row = (await database.query(`SELECT s.yjs_state,s.state_vector,s.document_sequence FROM collaboration_documents d
        JOIN file_collaboration_lineages l ON l.id=d.lineage_id JOIN collaboration_yjs_states s ON s.document_id=d.id
        WHERE d.id=$1 AND d.workspace_id=$2 AND d.path=$3 AND d.lineage_id=$4 AND d.organization_id=$5
          AND d.workspace_type='organization' AND d.status='active' AND d.provider='yjs' AND d.yjs_state_lifecycle='initialized'
          AND l.workspace_id=d.workspace_id AND l.path=d.path AND l.organization_id=d.organization_id
          AND l.workspace_type=d.workspace_type AND l.status='active'
          AND s.workspace_id=d.workspace_id AND s.path=d.path AND s.organization_id=d.organization_id AND s.status='active'
          AND s.lifecycle_generation=1 AND s.schema_version=1 AND s.representation='tiptap_blocks'`,
      [expected.documentId,expected.workspaceId,expected.path,expected.lineageId,workspace.organizationId])).rows[0];
      assert(row, 'The genuine People UI must preserve the exact original native identity.');
      assert.equal(Number(row.document_sequence), 1);
      assert.deepEqual(Buffer.from(row.yjs_state), expected.yjsState, 'UI creation must not replace native AST with the stale physical projection.');
      assert.deepEqual(Buffer.from(row.state_vector), expected.stateVector);
    });
    assert.equal(await fs.realpath(fullPath), fullPath);
    assertOriginalIdentity(await fs.lstat(fullPath));
    await fs.unlink(fullPath);
    assert.equal((await handle.stat()).nlink, 0);
    await assert.rejects(fs.lstat(fullPath), { code: 'ENOENT' });
  } finally { await handle.close(); }
}
