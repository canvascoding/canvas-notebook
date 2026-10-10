import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import * as Y from 'yjs';

import type { SqlConnection } from '../app/lib/db';
import { serializeCanonicalText } from '../app/lib/collaboration/persistence';
import { createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { buildWorkspaceAuthoritativePlannerSnapshot } from '../app/lib/markdown/workspace-authoritative-planner-snapshot';
import { buildWorkspacePlannerSnapshot } from '../app/lib/markdown/workspace-file-operation-preview';
import { createWorkspaceFileOperationPlan } from '../app/lib/markdown/workspace-file-operation-planner';
import { MAX_INDEXED_MARKDOWN_BYTES } from '../app/lib/markdown/workspace-link-limits';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

async function main(): Promise<void> {
  const pg = new PGlite();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-authoritative-planner-'));
  const workspace: WorkspaceContext = { workspaceId: 'workspace', workspaceType: 'personal',
    rootPath: root, rootRelativePath: 'workspace', ownerUserId: 'user', organizationId: null, status: 'active', legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true, canManageWorkspace: true, canCreatePublicLinks: false } };
  const options = { workspace };
  const oldHtml = '<img src="canvas-holdings-screenshot.png" alt="Fixture">';
  const changedHtml = '<img src="ek-fuchs-transkript.md" alt="Fixture">';
  let opened = 0;
  let closed = 0;
  let bulkQueries = 0;
  const dependencies = { buildDiskSnapshot: buildWorkspacePlannerSnapshot, openConnection: async (): Promise<SqlConnection> => {
    opened += 1;
    return { get: async (sql, params = []) => (await pg.query(sql, params)).rows[0],
      all: async (sql, params = []) => { if (sql.includes('FROM collaboration_documents')) bulkQueries += 1;
        return (await pg.query(sql, params)).rows; },
      run: async (sql, params = []) => pg.query(sql, params), close: () => { closed += 1; } };
  } };
  const snapshot = () => buildWorkspaceAuthoritativePlannerSnapshot(workspace.workspaceId, options, dependencies);
  const plan = async () => createWorkspaceFileOperationPlan({ kind: 'move', sourceWorkspaceId: workspace.workspaceId,
    destinationWorkspaceId: workspace.workspaceId, selections: [{ sourcePath: 'ek-fuchs-transkript.md', destinationPath: 'Notizen/ek-fuchs-transkript.md' }],
    snapshots: [await snapshot()] });
  const source = (result: Awaited<ReturnType<typeof snapshot>>) => result.entries.find((entry) => entry.path === 'test.md')!;
  const persist = async (canonical: string, newlineStyle: 'lf' | 'crlf' = 'lf', hasBom = false) => {
    const doc = new Y.Doc();
    doc.getText('content').insert(0, canonical);
    try {
      await pg.query(`INSERT INTO collaboration_yjs_states VALUES
        ('document','workspace',NULL,'test.md','plain_text',1,1,$1,$2,2,2,NULL,0,NULL,NULL,$3,$4,FALSE,'active')
        ON CONFLICT(document_id) DO UPDATE SET workspace_id='workspace',organization_id=NULL,path='test.md',
          representation='plain_text',schema_version=1,yjs_state=$1,state_vector=$2,newline_style=$3,has_bom=$4,degraded=FALSE,status='active'`,
      [Y.encodeStateAsUpdate(doc), Y.encodeStateVector(doc), newlineStyle, hasBom]);
    } finally { doc.destroy(); }
  };
  try {
    await pg.exec(`CREATE TABLE collaboration_documents(id TEXT PRIMARY KEY,path TEXT,workspace_id TEXT,
      organization_id TEXT,provider TEXT,status TEXT,state_version INTEGER);
      CREATE TABLE collaboration_yjs_state_backups(document_id TEXT);
      CREATE TABLE collaboration_agent_operations(document_id TEXT);
      CREATE TABLE collaboration_yjs_states(document_id TEXT PRIMARY KEY,workspace_id TEXT,organization_id TEXT,path TEXT,
        representation TEXT,lifecycle_generation INTEGER,schema_version INTEGER,yjs_state BYTEA,state_vector BYTEA,
        document_sequence BIGINT,persisted_at BIGINT,checkpointed_at BIGINT,checkpoint_sequence BIGINT,
        canonical_hash TEXT,serialized_hash TEXT,newline_style TEXT,has_bom BOOLEAN,degraded BOOLEAN,status TEXT);`);
    await fs.mkdir(path.join(root, 'Notizen'));
    await fs.writeFile(path.join(root, 'test.md'), oldHtml);
    await fs.writeFile(path.join(root, 'ek-fuchs-transkript.md'), '# Transkript');
    await fs.writeFile(path.join(root, 'canvas-holdings-screenshot.png'), Buffer.from([0, 1, 2]));
    const disk = await buildWorkspacePlannerSnapshot(workspace.workspaceId, options);
    const plain = await snapshot();
    assert.equal(source(plain).markdownContent, oldHtml, 'Files without collaboration state retain disk authority');
    assert.deepEqual(plain.entries, disk.entries);
    assert.equal(opened, 1);
    assert.equal(closed, 1);
    assert.equal(bulkQueries, 1, 'All Markdown identities use one bulk read');
    const original = await plan();
    assert.equal(original.readiness, 'ready');
    await pg.query("INSERT INTO collaboration_documents VALUES ('document','test.md','workspace',NULL,'yjs','active',0)");
    assert.equal(source(await snapshot()).markdownContent, oldHtml, 'Pristine registered version-zero uploads may retain disk bytes');
    await persist(changedHtml);
    const changed = await plan();
    assert.equal(changed.readiness, 'blocked', 'Durable authored HTML must invalidate the unrelated-image proof before file projection');
    assert.equal(changed.linkAssessment?.blockers[0]?.reason, 'affected-html-link');
    assert.notEqual(changed.planId, original.planId);
    assert.equal(source(await snapshot()).markdownContent, changedHtml);
    assert.equal(source(disk).markdownContent, oldHtml, 'Overlay does not mutate the supplied disk snapshot');
    assert.equal(await fs.readFile(path.join(root, 'test.md'), 'utf8'), oldHtml, 'Read-only overlay never projects the changed Yjs content');
    assert.equal((await pg.query<{ state_version: number }>("SELECT state_version FROM collaboration_documents WHERE id='document'")).rows[0].state_version, 0,
      'Read-only overlay never mutates document metadata');

    for (const profile of [{ newlineStyle: 'lf' as const, hasBom: false }, { newlineStyle: 'crlf' as const, hasBom: false },
      { newlineStyle: 'lf' as const, hasBom: true }, { newlineStyle: 'crlf' as const, hasBom: true }]) {
      const canonical = '# Grüße 😀\nZweite Zeile\n';
      await persist(canonical, profile.newlineStyle, profile.hasBom);
      assert.equal(source(await snapshot()).markdownContent, serializeCanonicalText(canonical, profile), 'Preserve authoritative UTF-8/BOM/newline byte profile');
    }
    await fs.writeFile(path.join(root, 'test.md'), '# Plain disk content\n');
    await persist(changedHtml);
    assert.equal(source(await snapshot()).markdownContent, changedHtml, 'New HTML present only in Yjs must enter the fresh link graph');
    assert.equal((await plan()).readiness, 'blocked');
    const opaqueHtml = '<img src="canvas-holdings-screenshot.png" style="background-image:image-set(\'ek-fuchs-transkript.md\' 1x)">';
    await persist(opaqueHtml);
    assert.equal(source(await snapshot()).markdownContent, opaqueHtml, 'The selection includes HTML without certified targets');
    assert.equal((await plan()).linkAssessment?.blockers[0]?.reason, 'unevaluated-link');
    await fs.writeFile(path.join(root, 'test.md'), oldHtml);
    await persist('# HTML removed\n');
    assert.equal(source(await snapshot()).markdownContent, '# HTML removed\n', 'Removing old HTML also requires current canonical truth');
    assert.equal((await plan()).readiness, 'ready');
    assert.notEqual((await plan()).planId, original.planId);

    await fs.writeFile(path.join(root, 'test.md'), '# Plain disk content\n');
    const textDisk = await buildWorkspacePlannerSnapshot(workspace.workspaceId, options);
    const textPlan = (snapshot: typeof textDisk) => createWorkspaceFileOperationPlan({ kind: 'move',
      sourceWorkspaceId: workspace.workspaceId, destinationWorkspaceId: workspace.workspaceId,
      selections: [{ sourcePath: 'test.md', destinationPath: 'Notizen/test.md' }], snapshots: [snapshot] });
    for (const canonical of ['# Authored text edit\n', '<img src="https://example.com/image.png">',
      '```html\n<img src="ek-fuchs-transkript.md">\n```', '`<img src="ek-fuchs-transkript.md">`',
      '---\nexample: <img src="ek-fuchs-transkript.md">\n---\n# Text']) {
      await persist(canonical);
      const untouched = await snapshot();
      assert.deepEqual(untouched.entries, textDisk.entries, 'HTML-free graph leaves all existing disk entry fences intact');
      assert.equal(textPlan(untouched).planId, textPlan(textDisk).planId, 'Ordinary authored changes retain the existing worker preflight plan semantics');
    }
    const rich = createRichMarkdownYDoc('# Authored rich edit\n\nAccepted paragraph\n', 'tiptap_blocks');
    try {
      await pg.query(`UPDATE collaboration_yjs_states SET representation='tiptap_blocks',schema_version=3,
        yjs_state=$1,state_vector=$2 WHERE document_id='document'`, [Y.encodeStateAsUpdate(rich), Y.encodeStateVector(rich)]);
    } finally { rich.destroy(); }
    const unchangedRichPlan = await snapshot();
    assert.deepEqual(unchangedRichPlan.entries, textDisk.entries, 'Validated ordinary rich edits retain existing physical checkpoint semantics');
    assert.equal(textPlan(unchangedRichPlan).planId, textPlan(textDisk).planId);
    await fs.writeFile(path.join(root, 'test.md'), oldHtml);
    for (const modification of ["status='archived'", 'degraded=TRUE', "workspace_id='other-workspace'",
      "organization_id='other-organization'", "path='other.md'", "state_vector='\\x00'::bytea"]) {
      await persist(oldHtml);
      await pg.query(`UPDATE collaboration_yjs_states SET ${modification} WHERE document_id='document'`);
      const invalid = source(await snapshot());
      assert.equal(invalid.omissionReason, 'source-unreadable', modification);
      assert.equal(invalid.markdownContent, undefined, 'Invalid known authority must never fall back to disk');
    }
    await pg.query('DELETE FROM collaboration_yjs_states');
    await pg.query("UPDATE collaboration_documents SET state_version=1 WHERE id='document'");
    assert.equal(source(await snapshot()).omissionReason, 'source-unreadable', 'Missing versioned Yjs state is not a pristine upload');
    await pg.query("UPDATE collaboration_documents SET state_version=0 WHERE id='document'");
    for (const table of ['collaboration_yjs_state_backups', 'collaboration_agent_operations']) {
      await pg.query(`INSERT INTO ${table} VALUES ('document')`);
      assert.equal(source(await snapshot()).omissionReason, 'source-unreadable', 'Historical state prevents disk fallback');
      await pg.query(`DELETE FROM ${table}`);
    }
    await persist('ü'.repeat(MAX_INDEXED_MARKDOWN_BYTES / 2 + 1));
    assert.equal(source(await snapshot()).omissionReason, 'source-too-large', 'Limit serialized UTF-8 bytes rather than JS characters');
    await persist(oldHtml);
    const failure = await buildWorkspaceAuthoritativePlannerSnapshot(workspace.workspaceId, options, {
      buildDiskSnapshot: buildWorkspacePlannerSnapshot, openConnection: async () => { throw new Error('Database unavailable'); },
    });
    assert.equal(source(failure).omissionReason, 'source-unreadable', 'Unavailable authority catalogue must fail closed');
    assert.equal(opened, closed, 'Every opened connection is released');
    console.log('authoritative planner snapshots: persisted Yjs vs stale disk, blocked/different fresh plan, pristine/missing/history/archived/quarantine, namespace/vector/UTF8 profiles and byte limits, read-only bulk connection OK');
  } finally { await pg.close(); await fs.rm(root, { recursive: true, force: true }); }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
