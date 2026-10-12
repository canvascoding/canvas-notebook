import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
import * as Y from 'yjs';
import type { SqlConnection } from '../app/lib/db';
import { authoritativeCollaborationSnapshot } from '../app/lib/collaboration/checkpoint';
import { loadCollaborationStateOnConnection, serializeCanonicalText } from '../app/lib/collaboration/persistence';
import type * as Fence from '../app/lib/files/workspace-operation-batch-approval-fence';
import { assertWorkspaceHtmlLinkEvidenceCurrent } from '../app/lib/files/workspace-html-link-evidence-fence';
import { buildWorkspaceOperationBatchPlan as buildBatchPlan } from '../app/lib/files/workspace-operation-batch-plan';
import { buildWorkspacePlannerSnapshot } from '../app/lib/markdown/workspace-file-operation-preview';
import type { WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';

const buildWorkspaceOperationBatchPlan = (input: Parameters<typeof buildBatchPlan>[0]) =>
  buildBatchPlan(input, { buildSnapshot: buildWorkspacePlannerSnapshot });

async function main(): Promise<void> {
  const pg = new PGlite();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-approval-fence-'));
  const scope: WorkspaceOperationBatchScope = { workspace: { workspaceId: 'workspace', workspaceType: 'personal',
    rootPath: root, rootRelativePath: 'workspace', ownerUserId: 'user', organizationId: null, status: 'active', legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true, canManageWorkspace: true, canCreatePublicLinks: false } }, fileOptions: {} };
  scope.fileOptions = { workspace: scope.workspace };
  const file = path.resolve('app/lib/files/workspace-operation-batch-approval-fence.ts');
  const source = ts.transpileModule(await fs.readFile(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const load = createRequire(file);
  const reads: string[] = [];
  const connection: SqlConnection = {
    get: async (sql, params = []) => (await pg.query(sql, params)).rows[0],
    all: async (sql, params = []) => {
      if (sql.includes('FROM collaboration_documents')) reads.push(...params[1] as string[]);
      return (await pg.query(sql, params)).rows;
    },
    run: async (sql, params = []) => pg.query(sql, params), close: () => undefined,
  };
  const fence = { exports: {} as typeof Fence };
  new Function('require', 'module', 'exports', source)((name: string) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db') return { openDb: async () => connection };
    if (name.endsWith('/collaboration/persistence')) return {
      loadCollaborationStateIncludingArchived: (id: string) => loadCollaborationStateOnConnection(connection, id, true),
      serializeCanonicalText,
    };
    if (name.endsWith('/collaboration/checkpoint')) return { authoritativeCollaborationSnapshot };
    return load(name);
  }, fence, fence.exports);
  const build = () => buildWorkspaceOperationBatchPlan({ scope, actions: [{ reviewId: 'review_1234567890', kind: 'move',
    selections: [{ sourcePath: 'source.md', destinationPath: 'moved.md' }] }] });
  try {
    await pg.exec(`CREATE TABLE collaboration_documents(id TEXT PRIMARY KEY,path TEXT,workspace_id TEXT,
      provider TEXT,status TEXT,state_version INTEGER);
      CREATE TABLE collaboration_yjs_state_backups(document_id TEXT);
      CREATE TABLE collaboration_agent_operations(document_id TEXT);
      CREATE TABLE collaboration_yjs_states(document_id TEXT PRIMARY KEY,workspace_id TEXT,organization_id TEXT,path TEXT,
        representation TEXT,lifecycle_generation INTEGER,schema_version INTEGER,yjs_state BYTEA,state_vector BYTEA,
        document_sequence BIGINT,persisted_at BIGINT,checkpointed_at BIGINT,checkpoint_sequence BIGINT,
        canonical_hash TEXT,serialized_hash TEXT,newline_style TEXT,has_bom BOOLEAN,degraded BOOLEAN,status TEXT);`);
    await pg.query(`INSERT INTO collaboration_documents VALUES ('document','source.md','workspace','yjs','active',0),
      ('backlink','index.md','workspace','yjs','active',0)`);
    const persistSource = async (canonical: string, newlineStyle = 'lf', hasBom = false) => {
      const doc = new Y.Doc();
      doc.getText('content').insert(0, canonical);
      try {
        await pg.query(`INSERT INTO collaboration_yjs_states VALUES
          ('document','workspace',NULL,'source.md','plain_text',1,1,$1,$2,1,1,NULL,0,'hash','hash',$3,$4,FALSE,'active')
          ON CONFLICT(document_id) DO UPDATE SET yjs_state=$1,state_vector=$2,newline_style=$3,has_bom=$4,status='active'`,
        [Y.encodeStateAsUpdate(doc), Y.encodeStateVector(doc), newlineStyle, hasBom]);
      } finally { doc.destroy(); }
    };
    await fs.writeFile(path.join(root, 'source.md'), '# Source\n');
    await fs.writeFile(path.join(root, 'index.md'), '[Source](source.md)\n');
    const original = await build();
    await fence.exports.assertWorkspaceOperationBatchApprovalCurrent(original, scope);
    assert.equal((await pg.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM collaboration_yjs_states')).rows[0].count, 0,
      'registered version-zero upload approval remains read-only and does not initialize Yjs');
    assert.ok(reads.includes('source.md'), 'selected Markdown source receives an authoritative content fence even without link edits');
    assert.ok(reads.includes('index.md'), 'edited backlink documents receive an authoritative fence');
    await persistSource('# Source\n');
    await fence.exports.assertWorkspaceOperationBatchApprovalCurrent(original, scope);
    await pg.query("UPDATE collaboration_yjs_states SET status='archived'");
    await assert.rejects(fence.exports.assertWorkspaceOperationBatchApprovalCurrent(original, scope), { code: 'PREVIEW_STALE', status: 409 });
    await pg.query('DELETE FROM collaboration_yjs_states');
    await pg.query('UPDATE collaboration_documents SET state_version=1 WHERE id=$1', ['document']);
    await assert.rejects(fence.exports.assertWorkspaceOperationBatchApprovalCurrent(original, scope), { code: 'PREVIEW_STALE', status: 409 },
      'a missing previously checkpointed state never becomes a pristine upload');
    await pg.query('UPDATE collaboration_documents SET state_version=0 WHERE id=$1', ['document']);
    for (const table of ['collaboration_yjs_state_backups', 'collaboration_agent_operations']) {
      await pg.query(`INSERT INTO ${table} VALUES ('document')`);
      await assert.rejects(fence.exports.assertWorkspaceOperationBatchApprovalCurrent(original, scope), { code: 'PREVIEW_STALE', status: 409 },
        'retained state history prevents the upload exception');
      await pg.query(`DELETE FROM ${table}`);
    }
    for (const profile of [{ newlineStyle: 'crlf' as const, hasBom: false }, { newlineStyle: 'lf' as const, hasBom: true },
      { newlineStyle: 'crlf' as const, hasBom: true }]) {
      await fs.writeFile(path.join(root, 'source.md'), serializeCanonicalText('# Source\nSecond line\n', profile));
      const encoded = await build();
      await persistSource('# Source\nSecond line\n', profile.newlineStyle, profile.hasBom);
      await fence.exports.assertWorkspaceOperationBatchApprovalCurrent(encoded, scope);
      await persistSource('# Authored edit\n', profile.newlineStyle, profile.hasBom);
      await assert.rejects(fence.exports.assertWorkspaceOperationBatchApprovalCurrent(encoded, scope), { code: 'PREVIEW_STALE', status: 409 });
    }
    await pg.query('DELETE FROM collaboration_yjs_states');
    await fs.writeFile(path.join(root, 'source.md'), '# Changed\n');
    await assert.rejects(fence.exports.assertWorkspaceOperationBatchApprovalCurrent(original, scope), { code: 'PREVIEW_STALE', status: 409 });
    const current = await build();
    await persistSource('# Changed in Yjs but not projected\n');
    await assert.rejects(fence.exports.assertWorkspaceOperationBatchApprovalCurrent(current, scope), { code: 'PREVIEW_STALE', status: 409 },
      'unprojected source edits are rejected before approval');
    await pg.query('DELETE FROM collaboration_yjs_states');
    await fs.writeFile(path.join(root, 'new-backlink.md'), '[New backlink](source.md)\n');
    await fence.exports.assertWorkspaceOperationBatchApprovalCurrent(current, scope);
    assert.notEqual((await build()).planId, current.planId,
      'cheap targeted approval defers newly introduced graph changes to the full execution-worker preflight');
    const beforeBacklinkEdit = await build();
    await fs.writeFile(path.join(root, 'index.md'), '[Edited label](source.md)\n');
    await assert.rejects(fence.exports.assertWorkspaceOperationBatchApprovalCurrent(beforeBacklinkEdit, scope), { code: 'PREVIEW_STALE', status: 409 });
    const beforeCollision = await build();
    await fs.writeFile(path.join(root, 'moved.md'), '# Occupied\n');
    await assert.rejects(fence.exports.assertWorkspaceOperationBatchApprovalCurrent(beforeCollision, scope), { code: 'PREVIEW_STALE', status: 409 });

    const htmlContent = '# HTML source\n\n<img src="image.png" alt="Fixture">\n';
    await fs.writeFile(path.join(root, 'source.md'), htmlContent);
    await fs.writeFile(path.join(root, 'image.png'), 'Unchanged image bytes');
    await fs.writeFile(path.join(root, 'other.md'), '# Independent document\n');
    await persistSource(htmlContent);
    const htmlPlan = await buildWorkspaceOperationBatchPlan({ scope, actions: [{ reviewId: 'html_review_1234567890', kind: 'move',
      selections: [{ sourcePath: 'other.md', destinationPath: 'other-moved.md' }] }] });
    assert.equal(htmlPlan.readiness, 'ready', JSON.stringify(htmlPlan.issues));
    assert.ok(htmlPlan.linkAssessment.warnings.some((warning) => warning.sourcePath === 'source.md'
      && warning.reason === 'unaffected-explicit-html-link'));
    const beforeHtmlFence = reads.length;
    await assertWorkspaceHtmlLinkEvidenceCurrent(htmlPlan, scope, fence.exports.assertWorkspaceOperationBatchApprovalCurrent);
    assert.deepEqual(reads.slice(beforeHtmlFence), ['source.md'], 'The HTML-only fence queries only its unchanged source');

    const withoutHtmlWarnings = { ...htmlPlan, linkAssessment: { ...htmlPlan.linkAssessment,
      warnings: htmlPlan.linkAssessment.warnings.filter((warning) => warning.reason !== 'unaffected-explicit-html-link') } };
    const beforeNoHtmlFence = reads.length;
    await assertWorkspaceHtmlLinkEvidenceCurrent(withoutHtmlWarnings, scope, fence.exports.assertWorkspaceOperationBatchApprovalCurrent);
    assert.equal(reads.length, beforeNoHtmlFence, 'A plan without HTML evidence performs no collaboration guard queries');
    const withoutHtmlSourceProof = { ...htmlPlan, expectedPathState: htmlPlan.expectedPathState.filter((entry) => entry.path !== 'source.md') };
    await assert.rejects(assertWorkspaceHtmlLinkEvidenceCurrent(withoutHtmlSourceProof, scope,
      fence.exports.assertWorkspaceOperationBatchApprovalCurrent), { code: 'PREVIEW_STALE', status: 409 },
    'An HTML warning without its pinned source proof cannot authorize a path mutation');
    assert.equal(reads.length, beforeNoHtmlFence, 'Missing HTML source evidence fails before querying collaboration');

    await persistSource(htmlContent.replace('src="image.png"', 'src="other.md"'));
    assert.equal(await fs.readFile(path.join(root, 'source.md'), 'utf8'), htmlContent, 'The peer edit has not reached disk');
    await assert.rejects(assertWorkspaceHtmlLinkEvidenceCurrent(htmlPlan, scope,
      fence.exports.assertWorkspaceOperationBatchApprovalCurrent), { code: 'PREVIEW_STALE', status: 409 },
    'The durable Yjs target change rejects the old unaffected HTML proof despite unchanged disk bytes');
    assert.equal(await fs.readFile(path.join(root, 'source.md'), 'utf8'), htmlContent, 'The guard never rewrites the HTML source');
    assert.equal(await fs.readFile(path.join(root, 'other.md'), 'utf8'), '# Independent document\n');
    await assert.rejects(fs.stat(path.join(root, 'other-moved.md')), { code: 'ENOENT' });
    console.log('batch approval fence: pristine registered uploads, actual persisted Yjs, archived/missing/history safeguards, BOM/CRLF serialization, targeted path/byte checks, unchanged HTML live-source evidence and full graph deferred to worker OK');
  } finally { await pg.close(); await fs.rm(root, { recursive: true, force: true }); }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
