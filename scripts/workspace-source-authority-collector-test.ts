import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { getSchema } from '@tiptap/core';
import * as Y from 'yjs';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { createPlainTextYDoc, createRichMarkdownYDoc, richMarkdownSchemaExtensions,
  validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { mapValidatedNativeStateRow } from '../app/lib/collaboration/native-session-state-reader';
import { withNativeInspectionSchema } from '../app/lib/collaboration/native-inspection-schema';
import { COLLABORATION_FAILURE_CODES } from '../app/lib/collaboration/failure';
import { nativeLinkJsonProof } from '../app/lib/markdown/workspace-native-link-inventory';
import { previewStagedWorkspaceLinkEffects } from '../app/lib/markdown/workspace-physical-link-inventory';
import { readWorkspaceLinkSourceAuthorityOnConnection } from '../app/lib/markdown/workspace-source-authority-stage';
import { documentLinkReadProjectionStatistics, withFreshDocumentLinkReadProjection } from '../app/lib/markdown/document-link-read-projection';

// Actual embedded PostgreSQL queries and real FS/Yjs. Minimal owned tables model
// the read contract only: no production DDL/ACL/backend/lock/concurrency proof.
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
test('strict source authority collector with caller-owned embedded SQL and genuine FS/Yjs', async t => {
  const sql = new PGlite();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-source-collector-'));
  const workspace: WorkspaceContext = { workspaceId: `collector-${randomUUID()}`, workspaceType: 'personal',
    rootPath: root, organizationId: null, legacy: false, status: 'active', permissions: {
      canRead: true, canWrite: true, canDelete: true, canManageWorkspace: true, canCreatePublicLinks: true, canRunAgent: true,
    } };
  const trace: Array<{ sql: string; values: unknown[]; returnedRows: number; binaryBytes: number }> = [];
  let beforeQuery: ((statement: string, values: unknown[]) => Promise<void>) | undefined;
  let closes = 0;
  const query = async (statement: string, values: unknown[] = []) => {
    const entry = { sql: statement, values, returnedRows: 0, binaryBytes: 0 };
    trace.push(entry); await beforeQuery?.(statement, values);
    const result = await sql.query<Record<string, unknown>>(statement, values);
    entry.returnedRows = result.rows.length;
    entry.binaryBytes = result.rows.reduce((sum, row) => sum
      + (row.yjs_state instanceof Uint8Array ? row.yjs_state.byteLength : 0)
      + (row.state_vector instanceof Uint8Array ? row.state_vector.byteLength : 0), 0);
    return result;
  };
  const connection: SqlConnection = { get: async (statement, values) => (await query(statement, values)).rows[0],
    all: async (statement, values) => (await query(statement, values)).rows,
    run: async (statement, values) => ({ changes: (await query(statement, values)).affectedRows ?? 0 }),
    close: async () => { closes++; assert.fail('Borrowed collector must not close its caller connection.'); } };
  try {
    await sql.exec(`CREATE TABLE file_collaboration_lineages(id text PRIMARY KEY,workspace_id text,workspace_type text,
      organization_id text,customer_id text,project_id text,path text,status text,archived_at bigint,trash_entry_id text);
      CREATE TABLE collaboration_documents(id text PRIMARY KEY,lineage_id text,workspace_id text,workspace_type text,
      organization_id text,customer_id text,project_id text,path text,provider text,status text,state_version bigint,yjs_state_lifecycle text);
      CREATE TABLE collaboration_yjs_states(document_id text PRIMARY KEY,workspace_id text,organization_id text,path text,
      representation text,lifecycle_generation bigint,schema_version bigint,status text,yjs_state bytea,state_vector bytea,
      document_sequence bigint,persisted_at bigint,checkpoint_sequence bigint,checkpointed_at bigint,canonical_hash text,serialized_hash text,
      newline_style text,has_bom bigint,degraded bigint,projection_error_code text,projection_error_sequence bigint,
      projection_error_generation bigint,projection_error_phase text,projection_error_permanent bigint);
      CREATE TABLE collaboration_yjs_state_backups(document_id text); CREATE TABLE collaboration_agent_operations(document_id text);`);
    const seed = async (filePath = ' note .md', representation: 'plain_text' | 'tiptap_xml' | 'tiptap_blocks' = 'tiptap_blocks',
      options: { text?: string; prepare?: (doc: Y.Doc) => void } = {}) => {
      const documentId = `doc-${randomUUID()}`, lineageId = `lineage-${randomUUID()}`;
      const doc = representation === 'plain_text' ? createPlainTextYDoc(options.text ?? '[Target](target.md)')
        : createRichMarkdownYDoc(options.text ?? '[Target](target.md)', representation);
      let binary: Uint8Array, vector: Uint8Array;
      try { options.prepare?.(doc); binary = Y.encodeStateAsUpdate(doc); vector = Y.encodeStateVector(doc); }
      finally { doc.destroy(); }
      await sql.query(`INSERT INTO file_collaboration_lineages VALUES($1,$2,'personal',NULL,NULL,NULL,$3,'active',NULL,NULL)`,
        [lineageId, workspace.workspaceId, filePath]);
      await sql.query(`INSERT INTO collaboration_documents VALUES($1,$2,$3,'personal',NULL,NULL,NULL,$4,'yjs','active',7,'initialized')`,
        [documentId, lineageId, workspace.workspaceId, filePath]);
      await sql.query(`INSERT INTO collaboration_yjs_states VALUES($1,$2,NULL,$3,$4,3,1,'active',$5,$6,7,100,0,NULL,NULL,NULL,
        'crlf',1,0,NULL,NULL,NULL,NULL,0)`, [documentId, workspace.workspaceId, filePath, representation, binary!, vector!]);
      return { documentId, lineageId, filePath, binary: binary!, vector: vector! };
    };
    const read = () => readWorkspaceLinkSourceAuthorityOnConnection(connection, workspace);
    const reset = async () => {
      beforeQuery = undefined;
      await sql.exec('ROLLBACK');
      await sql.exec('TRUNCATE collaboration_documents,collaboration_yjs_states,file_collaboration_lineages,collaboration_yjs_state_backups,collaboration_agent_operations');
      for (const name of await fs.readdir(root)) await fs.rm(path.join(root, name), { recursive: true, force: true });
      await sql.exec('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); trace.length = 0;
    };
    const fixture = async (name: string, operation: () => Promise<void>) => t.test(name, async () => {
      await reset(); await operation();
      assert.equal(closes, 0);
      assert(trace.every(entry => /^\s*(?:SELECT\b|WITH expected AS MATERIALIZED \()/u.test(entry.sql)), 'Collector must issue only fixed read statements.');
      assert(trace.every(entry => !/pg_advisory_|\b(?:BEGIN|COMMIT|ROLLBACK|SET|CLOSE|INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|CREATE)\b/iu.test(entry.sql)));
      await sql.query('SELECT 1 AS caller_connection_still_usable');
    });
    await fixture('N0 keeps all three catalogue probes and issues no native header or binary read', async () => {
      const observed = await read(); assert.equal(observed.stage.coverage.complete, true);
      assert.equal(observed.nativeBindings.length, 0); assert.equal(observed.privateNativeStates.length, 0);
      assert.equal(trace.filter(entry => entry.sql.includes('has_state_history')).length, 3);
      assert.equal(trace.filter(entry => entry.sql.startsWith('SELECT requested.document_id') || entry.sql.startsWith('WITH expected AS MATERIALIZED')).length, 0);
    });
    await fixture('coherent incomplete HTML keeps the private catalogue without certifying coverage', async () => {
      const native = await seed('native-html.md', 'plain_text', { text: '<img src="unrelated.png">\n' });
      await fs.writeFile(path.join(root, 'physical.html'), '<a href="other.md">Other</a>\n');
      const observed = await read();
      assert.equal(observed.stage.coverage.complete, false);
      assert.equal(observed.stage.readiness, 'blocked');
      assert.equal(observed.stage.executionReady, false);
      assert.equal(observed.stage.coverage.gaps.length, 2);
      assert(observed.stage.coverage.gaps.every(gap => gap.code === 'uninspected-html'));
      assert.equal(observed.privateCatalogue?.length, 1);
      assert.equal(observed.privateCatalogue?.[0].id, native.documentId);
      assert.equal(nativeLinkJsonProof(observed.privateCatalogue), observed.stage.catalogueProof);
      assert.equal(observed.privateNativeStates.length, 1);
      assert.equal(digest(observed.privateNativeStates[0].yjsState), digest(native.binary));
      assert.equal(Object.hasOwn(observed.stage, 'privateCatalogue'), false);
      assert.equal(observed.stage.sources.length, 2);
    });
    await fixture('N5 uses two actual header and binary collection passes without losing any native source', async () => {
      const targets = [];
      for (let index = 0; index < 5; index++) targets.push(await seed(`source-${index}.md`, ['plain_text', 'tiptap_xml', 'tiptap_blocks'][index%3] as 'plain_text' | 'tiptap_xml' | 'tiptap_blocks'));
      const observed = await read(); assert.equal(observed.stage.coverage.complete, true, JSON.stringify(observed.stage.coverage.gaps));
      assert.equal(observed.nativeBindings.length, 5); assert.equal(observed.privateNativeStates.length, 5); assert.equal(observed.stage.sources.length, 5);
      assert.equal(trace.filter(entry => entry.sql.startsWith('SELECT requested.document_id')).length, 2);
      const binaries = trace.filter(entry => entry.sql.startsWith('WITH expected AS MATERIALIZED'));
      assert.equal(binaries.length, 2); assert(binaries.every(entry => (entry.values[0] as string[]).length === 5));
      assert(binaries.every(entry => entry.sql.includes('octet_length(s.yjs_state)=expected.state_bytes')
        && entry.sql.includes('octet_length(s.state_vector)=expected.vector_bytes')));
      assert.equal(trace.filter(entry => entry.sql.includes('has_state_history')).length, 3);
      for (const target of targets) {
        const binding = observed.nativeBindings.find(value => value.expected.documentId === target.documentId); assert(binding);
        assert.equal(binding.expected.binaryHash, digest(target.binary)); assert.equal(binding.expected.vectorHash, digest(target.vector));
        assert.equal(binding.expected.path, target.filePath);
      }
    });
    await fixture('document-index charges discarded native payloads before admitting physical bytes', async () => {
      const target = await seed('unreadable.md', 'plain_text');
      const invalid = Buffer.concat([Buffer.from(target.binary), Buffer.from([255])]);
      await sql.query('UPDATE collaboration_yjs_states SET yjs_state=$1 WHERE document_id=$2', [invalid, target.documentId]);
      const physical = '# Physical source\n\n[Target](target.md)\n';
      await fs.writeFile(path.join(root, 'budget.md'), physical);
      const nativeBytes = invalid.byteLength + target.vector.byteLength;
      const observed = await withNativeInspectionSchema(() => readWorkspaceLinkSourceAuthorityOnConnection(connection, workspace,
        { sourceScope: 'document-index', limits: { maxTotalSourceBytes: nativeBytes + Buffer.byteLength(physical) - 1 } }));
      assert.equal(observed.stage.coverage.complete, false);
      assert(observed.stage.coverage.gaps.some(gap => gap.code === 'unreadable-native-source' && gap.path === target.filePath));
      assert.equal(trace.filter(entry => entry.sql.startsWith('WITH expected AS MATERIALIZED')).reduce((sum, entry) => sum + entry.binaryBytes, 0), nativeBytes);
      assert.equal(observed.stage.sources.some(source => source.kind === 'physical' && source.inventory.path === 'budget.md'), false,
        'Previously fetched invalid native bytes still consume the shared read budget.');
      assert(observed.stage.coverage.gaps.some(gap => gap.code === 'source-too-large' && gap.path === 'budget.md'));
      assert.equal(observed.stage.executionReady, false);
    });
    await fixture('document-index reuses only unchanged parsed inventories while retaining every SQL observation', async () => {
      const targets = [];
      for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
        targets.push(await seed(`projection-${representation}.md`, representation));
      }
      const indexRead = () => withNativeInspectionSchema(() => readWorkspaceLinkSourceAuthorityOnConnection(connection, workspace,
        { sourceScope: 'document-index' }));
      const before = documentLinkReadProjectionStatistics();
      const cold = await indexRead(), afterCold = documentLinkReadProjectionStatistics();
      assert.equal(cold.stage.coverage.complete, true, JSON.stringify(cold.stage.coverage.gaps));
      assert.equal(cold.stage.readiness, 'blocked'); assert.equal(cold.stage.executionReady, false);
      assert.equal(afterCold.inspections - before.inspections, 3);
      assert.equal(afterCold.hits - before.hits, 3, 'The second independent SQL pass can reuse its identical inspection.');
      const warm = await indexRead(), afterWarm = documentLinkReadProjectionStatistics();
      assert.deepEqual(warm, cold);
      assert.equal(afterWarm.inspections, afterCold.inspections);
      assert.equal(afterWarm.hits - afterCold.hits, 6);
      assert.equal(trace.filter(entry => entry.sql.includes('has_state_history')).length, 6);
      assert.equal(trace.filter(entry => entry.sql.startsWith('SELECT requested.document_id')).length, 4);
      assert.equal(trace.filter(entry => entry.sql.startsWith('WITH expected AS MATERIALIZED')).length, 4);
      assert.deepEqual(await withFreshDocumentLinkReadProjection(indexRead), warm);
      assert.equal(documentLinkReadProjectionStatistics().inspections - afterWarm.inspections, 6);

      const changed = createPlainTextYDoc('[Changed](new-target.md)');
      try {
        await sql.query('UPDATE collaboration_yjs_states SET yjs_state=$1,state_vector=$2 WHERE document_id=$3',
          [Y.encodeStateAsUpdate(changed), Y.encodeStateVector(changed), targets[0].documentId]);
      } finally { changed.destroy(); }
      const beforeDirty = documentLinkReadProjectionStatistics(), dirty = await indexRead(), afterDirty = documentLinkReadProjectionStatistics();
      assert.equal(dirty.stage.coverage.complete, true, JSON.stringify(dirty.stage.coverage.gaps));
      assert.equal(afterDirty.inspections - beforeDirty.inspections, 1, 'Only the changed document is decoded again.');
      assert.equal(afterDirty.hits - beforeDirty.hits, 5);
      assert.notDeepEqual(dirty.stage.sources, warm.stage.sources);
      assert.deepEqual(await withFreshDocumentLinkReadProjection(indexRead), dirty);

      const beforeStrict = documentLinkReadProjectionStatistics(), strict = await withNativeInspectionSchema(read);
      assert.equal(strict.stage.readiness, 'native-coordinator-required');
      assert.deepEqual(documentLinkReadProjectionStatistics(), beforeStrict, 'The mutation source profile never uses the read projection.');
    });
    await fixture('warm document-index projections retain fresh physical file and namespace observations', async () => {
      await seed('native.md', 'plain_text');
      await fs.writeFile(path.join(root, 'physical.md'), '[Old](old.md)');
      const indexRead = () => withNativeInspectionSchema(() => readWorkspaceLinkSourceAuthorityOnConnection(connection, workspace,
        { sourceScope: 'document-index' }));
      const first = await indexRead(), before = documentLinkReadProjectionStatistics();
      assert.equal(first.stage.coverage.complete, true);
      await fs.writeFile(path.join(root, 'physical.md'), '[New](added.md)');
      await fs.writeFile(path.join(root, 'added.md'), '# Added\n');
      const changed = await indexRead();
      assert.equal(changed.stage.coverage.complete, true);
      assert.notDeepEqual(changed.stage.sources, first.stage.sources);
      assert(changed.stage.namespace.some(entry => entry.path === 'added.md'));
      assert.equal(documentLinkReadProjectionStatistics().inspections, before.inspections);
      assert.deepEqual(await withFreshDocumentLinkReadProjection(indexRead), changed);
    });
    for (const drift of ['delete-only', 'quarantine', 'membership'] as const) await fixture(
      `warm document-index projection cannot conceal ${drift} drift during the physical observation`, async () => {
        const target = await seed('native.md', 'plain_text', { text: '[Target](target.md)' });
        await fs.writeFile(path.join(root, 'incoming.md'), '[Source](native.md)');
        const observed = await withNativeInspectionSchema(() => readWorkspaceLinkSourceAuthorityOnConnection(connection, workspace,
          { sourceScope: 'document-index' }));
        assert.equal(observed.stage.coverage.complete, true);
        let changes = 0;
        const changed = await withNativeInspectionSchema(() => readWorkspaceLinkSourceAuthorityOnConnection(connection, workspace,
          { sourceScope: 'document-index', afterSourceFingerprint: async () => {
            if (changes++) return;
            if (drift === 'quarantine') await sql.query('UPDATE collaboration_yjs_states SET degraded=1 WHERE document_id=$1', [target.documentId]);
            else if (drift === 'membership') await seed('new-member.md');
            else {
              const doc = new Y.Doc();
              try {
                Y.applyUpdate(doc, target.binary); doc.getText('content').delete(0, 1);
                assert.deepEqual(Y.encodeStateVector(doc), target.vector);
                await sql.query('UPDATE collaboration_yjs_states SET yjs_state=$1 WHERE document_id=$2',
                  [Y.encodeStateAsUpdate(doc), target.documentId]);
              } finally { doc.destroy(); }
            }
          } }));
        assert(changes > 0); assert.equal(changed.stage.coverage.complete, false);
        assert.equal(changed.stage.sources.length, 0); assert.equal(changed.nativeBindings.length, 0);
        assert.equal(changed.privateNativeStates.length, 0); assert.equal(changed.privateCatalogue, undefined);
        assert(changed.stage.coverage.gaps.some(gap => gap.code === (drift === 'membership' ? 'source-authority-changed' : 'native-source-changed')));
      });
    await fixture('unchanged native bytes still perform both fresh SQL passes and legacy hooks; evaluation results do not cross observations', async () => {
      const targets: Awaited<ReturnType<typeof seed>>[] = [];
      for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
        targets.push(await seed(`same-${representation}.md`, representation));
      }
      const loads: Array<{ documentId: string; binaryHash: string; vectorHash: string }> = [];
      const loadState: NonNullable<Parameters<typeof readWorkspaceLinkSourceAuthorityOnConnection>[2]>['loadState'] = async (database, documentId) => {
        const raw = await database.get('SELECT * FROM collaboration_yjs_states WHERE document_id = $1 LIMIT 1', [documentId]) as Record<string, unknown>;
        const state = await mapValidatedNativeStateRow(raw, documentId); assert(state);
        loads.push({ documentId, binaryHash: digest(state.yjsState), vectorHash: digest(state.stateVector) });
        return state;
      };
      const observed = await withNativeInspectionSchema(() => readWorkspaceLinkSourceAuthorityOnConnection(connection, workspace, { loadState }));
      assert.equal(observed.stage.coverage.complete, true, JSON.stringify(observed.stage.coverage.gaps));
      assert.equal(trace.filter(entry => entry.sql.startsWith('SELECT requested.document_id')).length, 2);
      assert.equal(trace.filter(entry => entry.sql.startsWith('WITH expected AS MATERIALIZED')).length, 2);
      assert.equal(loads.length, 6);
      for (const target of targets) {
        assert.deepEqual(loads.filter(load => load.documentId === target.documentId),
          [0, 1].map(() => ({ documentId: target.documentId, binaryHash: digest(target.binary), vectorHash: digest(target.vector) })));
      }
      const first = observed.privateNativeStates.find(state => state.documentId === targets[0].documentId); assert(first);
      first.yjsState[0] ^= 1;
      const again = await withNativeInspectionSchema(() => readWorkspaceLinkSourceAuthorityOnConnection(connection, workspace, { loadState }));
      assert.equal(again.stage.coverage.complete, true, JSON.stringify(again.stage.coverage.gaps));
      assert.equal(trace.filter(entry => entry.sql.startsWith('SELECT requested.document_id')).length, 4);
      assert.equal(trace.filter(entry => entry.sql.startsWith('WITH expected AS MATERIALIZED')).length, 4);
      assert.equal(loads.length, 12);
      for (const target of targets) {
        const current = again.privateNativeStates.find(state => state.documentId === target.documentId); assert(current);
        assert.equal(digest(current.yjsState), digest(target.binary)); assert.equal(digest(current.stateVector), digest(target.vector));
        assert.equal(loads.filter(load => load.documentId === target.documentId).length, 4);
      }
      assert.notEqual(again.privateNativeStates.find(state => state.documentId === first.documentId), first);
      assert.deepEqual((await sql.query<{ yjs_state: Uint8Array }>('SELECT yjs_state FROM collaboration_yjs_states WHERE document_id=$1', [targets[0].documentId])).rows[0].yjs_state, targets[0].binary);
    });
    await fixture('genuine Delete-only Yjs change with an identical statevector after the physical fingerprint discards the complete observation', async () => {
      const target = await seed('native-delete-only.md', 'plain_text', { text: '[Target](target.md)' });
      await fs.writeFile(path.join(root, 'incoming.md'), '[Source](native-delete-only.md)');
      const doc = new Y.Doc(); let deletedBinary: Uint8Array, unchangedVector: Uint8Array;
      try {
        Y.applyUpdate(doc, target.binary);
        const content = doc.getText('content'); assert.equal(content.toString(), '[Target](target.md)');
        content.delete(0, content.length); assert.equal(content.toString(), '');
        deletedBinary = Y.encodeStateAsUpdate(doc); unchangedVector = Y.encodeStateVector(doc);
        assert.deepEqual(unchangedVector, target.vector, 'Deleting existing Yjs items must leave the client clocks unchanged.');
        assert.notEqual(digest(deletedBinary), digest(target.binary), 'The full Yjs update must contain the real changed DeleteSet.');
      } finally { doc.destroy(); }
      let fingerprints = 0;
      const observed = await withNativeInspectionSchema(() => readWorkspaceLinkSourceAuthorityOnConnection(connection, workspace, { afterSourceFingerprint: async relativePath => {
        assert.equal(relativePath, 'incoming.md'); fingerprints++;
        await sql.query('UPDATE collaboration_yjs_states SET yjs_state=$1,state_vector=$2 WHERE document_id=$3',
          [deletedBinary!, unchangedVector!, target.documentId]);
      } }));
      assert.equal(fingerprints, 1);
      assert.equal(trace.filter(entry => entry.sql.startsWith('SELECT requested.document_id')).length, 2);
      assert.equal(trace.filter(entry => entry.sql.startsWith('WITH expected AS MATERIALIZED')).length, 2);
      assert.equal(observed.stage.coverage.complete, false); assert.equal(observed.stage.sources.length, 0);
      assert.equal(observed.nativeBindings.length, 0); assert.equal(observed.privateNativeStates.length, 0);
      assert.equal(observed.privateCatalogue, undefined);
      assert(observed.stage.coverage.gaps.some(gap => gap.code === 'native-source-changed'));
      const actual = (await sql.query<{ yjs_state: Uint8Array; state_vector: Uint8Array; document_sequence: number | string; persisted_at: number | string }>(
        'SELECT yjs_state,state_vector,document_sequence,persisted_at FROM collaboration_yjs_states WHERE document_id=$1', [target.documentId])).rows[0];
      assert.deepEqual(actual.state_vector, target.vector); assert.deepEqual(actual.yjs_state, deletedBinary!);
      assert.equal(Number(actual.document_sequence), 7); assert.equal(Number(actual.persisted_at), 100);
    });
    await fixture('a legacy loader mutation only on the second fresh pass rejects even when native bytes are unchanged', async () => {
      const target = await seed('second-hook.md', 'plain_text'); let loads = 0;
      const observed = await withNativeInspectionSchema(() => readWorkspaceLinkSourceAuthorityOnConnection(connection, workspace, { loadState: async (database, documentId) => {
        assert.equal(documentId, target.documentId); loads++;
        const raw = await database.get('SELECT * FROM collaboration_yjs_states WHERE document_id = $1 LIMIT 1', [documentId]) as Record<string, unknown>;
        const state = await mapValidatedNativeStateRow(raw, documentId); assert(state);
        assert.equal(digest(state.yjsState), digest(target.binary)); assert.equal(digest(state.stateVector), digest(target.vector));
        return loads === 2 ? { ...state, documentSequence: state.documentSequence + 1 } : state;
      } }));
      assert.equal(loads, 2, 'A pure-evaluation reuse must not bypass the second legacy fault hook.');
      assert.equal(trace.filter(entry => entry.sql.startsWith('SELECT requested.document_id')).length, 2);
      assert.equal(trace.filter(entry => entry.sql.startsWith('WITH expected AS MATERIALIZED')).length, 2);
      assert.equal(observed.stage.coverage.complete, false); assert.equal(observed.stage.sources.length, 0);
      assert.equal(observed.nativeBindings.length, 0); assert.equal(observed.privateNativeStates.length, 0);
      assert.equal(observed.privateCatalogue, undefined);
      assert(observed.stage.coverage.gaps.some(gap => gap.code === 'native-source-changed'));
      const actual = (await sql.query<{ yjs_state: Uint8Array; document_sequence: number | string }>(
        'SELECT yjs_state,document_sequence FROM collaboration_yjs_states WHERE document_id=$1', [target.documentId])).rows[0];
      assert.deepEqual(actual.yjs_state, target.binary); assert.equal(Number(actual.document_sequence), 7);
    });
    await fixture('N5 aggregate budget is checked for the whole collection before any binary query', async () => {
      let bytes = 0;
      for (let index = 0; index < 5; index++) { const target = await seed(`source-${index}.md`); bytes += target.binary.byteLength + target.vector.byteLength; }
      const observed = await readWorkspaceLinkSourceAuthorityOnConnection(connection, workspace, { limits: { maxTotalSourceBytes: bytes-1 } });
      assert.equal(observed.stage.coverage.complete, false); assert.equal(observed.stage.sources.length, 0);
      assert.equal(observed.nativeBindings.length, 0); assert.equal(observed.privateNativeStates.length, 0);
      assert(observed.stage.coverage.gaps.some(gap => gap.code === 'source-byte-limit'));
      assert.equal(observed.privateCatalogue, undefined, 'An incoherent collection retains no catalogue witness.');
      assert.equal(trace.filter(entry => entry.sql.startsWith('SELECT requested.document_id')).length, 1);
      assert.equal(trace.filter(entry => entry.sql.startsWith('WITH expected AS MATERIALIZED')).length, 0);
    });
    for (const fault of ['duplicate-header', 'missing-lineage', 'duplicate-binary', 'missing-binary', 'grown-binary'] as const) {
      await fixture(`${fault} from actual embedded SQL invalidates the whole observation`, async () => {
        const target = await seed(); let changed = false;
        beforeQuery = async statement => {
          const header = statement.startsWith('SELECT requested.document_id'), binary = statement.startsWith('WITH expected AS MATERIALIZED');
          if (changed || !(fault === 'duplicate-header' || fault === 'missing-lineage' ? header : binary)) return;
          changed = true;
          if (fault === 'duplicate-header') {
            await sql.exec('ALTER TABLE file_collaboration_lineages DROP CONSTRAINT file_collaboration_lineages_pkey');
            await sql.query('INSERT INTO file_collaboration_lineages SELECT * FROM file_collaboration_lineages WHERE id=$1', [target.lineageId]);
          } else if (fault === 'missing-lineage') await sql.query('DELETE FROM file_collaboration_lineages WHERE id=$1', [target.lineageId]);
          else if (fault === 'duplicate-binary') {
            await sql.exec('ALTER TABLE collaboration_yjs_states DROP CONSTRAINT collaboration_yjs_states_pkey');
            await sql.query('INSERT INTO collaboration_yjs_states SELECT * FROM collaboration_yjs_states WHERE document_id=$1', [target.documentId]);
          } else if (fault === 'missing-binary') await sql.query('DELETE FROM collaboration_yjs_states WHERE document_id=$1', [target.documentId]);
          else await sql.query("UPDATE collaboration_yjs_states SET yjs_state=yjs_state||decode('00','hex') WHERE document_id=$1", [target.documentId]);
        };
        const observed = await read(); assert.equal(changed, true); assert.equal(observed.stage.coverage.complete, false);
        assert.equal(observed.stage.sources.length, 0); assert.equal(observed.nativeBindings.length, 0); assert.equal(observed.privateNativeStates.length, 0);
        if (fault === 'duplicate-header' || fault === 'missing-lineage') assert.equal(trace.filter(entry => entry.sql.startsWith('WITH expected AS MATERIALIZED')).length, 0);
        assert(observed.stage.coverage.gaps.some(gap => gap.code === (fault === 'missing-lineage' ? 'native-identity-conflict' : 'native-source-changed')));
      });
    }
    await fixture('header output is bounded to N+1 even when a lineage key has many actual duplicates', async () => {
      const target = await seed();
      for (let index = 0; index < 4; index++) await seed(`small-${index}.md`);
      let changed = false;
      beforeQuery = async statement => {
        if (changed || !statement.startsWith('SELECT requested.document_id')) return;
        changed = true;
        await sql.exec('ALTER TABLE file_collaboration_lineages DROP CONSTRAINT file_collaboration_lineages_pkey');
        await sql.query(`INSERT INTO file_collaboration_lineages SELECT l.* FROM file_collaboration_lineages l
          CROSS JOIN generate_series(1,40) WHERE l.id=$1`, [target.lineageId]);
      };
      const observed = await read(); assert.equal(changed, true); assert.equal(observed.stage.coverage.complete, false);
      const headers = trace.filter(entry => entry.sql.startsWith('SELECT requested.document_id'));
      assert.equal(headers.length, 1); assert.equal(headers[0].returnedRows, 6);
      assert.equal(headers[0].binaryBytes, 0);
      assert.equal(trace.filter(entry => entry.sql.startsWith('WITH expected AS MATERIALIZED')).length, 0);
      assert.equal(observed.stage.sources.length, 0); assert.equal(observed.nativeBindings.length, 0);
      assert.equal(observed.privateNativeStates.length, 0);
    });
    for (const duplicateLength of ['same', 'different'] as const) await fixture(
      `binary transfer excludes every duplicated large ID before payload projection (${duplicateLength} lengths)`, async () => {
        const target = await seed('large.md', 'plain_text', { text: 'a'.repeat(1024*1024) });
        const small = [];
        for (let index = 0; index < 8; index++) small.push(await seed(`small-${index}.md`));
        const smallBytes = small.reduce((sum, row) => sum + row.binary.byteLength + row.vector.byteLength, 0);
        const originalTotal = target.binary.byteLength + target.vector.byteLength + smallBytes;
        let changed = false;
        beforeQuery = async statement => {
          if (changed || !statement.startsWith('WITH expected AS MATERIALIZED')) return;
          changed = true;
          await sql.exec('ALTER TABLE collaboration_yjs_states DROP CONSTRAINT collaboration_yjs_states_pkey');
          await sql.query(`INSERT INTO collaboration_yjs_states SELECT s.* FROM collaboration_yjs_states s
            CROSS JOIN generate_series(1,33) WHERE s.document_id=$1`, [target.documentId]);
          if (duplicateLength === 'different') {
            // Keep one original-length row. All other rows still count, even
            // though the final exact-length predicate would exclude them.
            await sql.query(`UPDATE collaboration_yjs_states SET yjs_state=yjs_state||decode('00','hex')
              WHERE ctid IN (SELECT ctid FROM collaboration_yjs_states WHERE document_id=$1 OFFSET 1)`, [target.documentId]);
          }
        };
        const observed = await readWorkspaceLinkSourceAuthorityOnConnection(connection, workspace,
          { limits: { maxTotalSourceBytes: originalTotal } });
        assert.equal(changed, true); assert.equal(observed.stage.coverage.complete, false);
        const binaries = trace.filter(entry => entry.sql.startsWith('WITH expected AS MATERIALIZED'));
        assert.equal(binaries.length, 1); assert.equal(binaries[0].returnedRows, small.length);
        assert.equal(binaries[0].binaryBytes, smallBytes);
        assert(binaries[0].binaryBytes < originalTotal);
        assert.equal(observed.stage.sources.length, 0); assert.equal(observed.nativeBindings.length, 0);
        assert.equal(observed.privateNativeStates.length, 0);
        assert(observed.stage.coverage.gaps.some(gap => gap.code === 'native-source-changed'));
      });
    for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
      await fixture(`${representation}: initialized empty sequence-zero source is inspected without a synthetic seed`, async () => {
        const target = await seed(undefined, representation, { text: '' });
        await sql.exec('UPDATE collaboration_documents SET state_version=0; UPDATE collaboration_yjs_states SET document_sequence=0');
        const observed = await read(); assert.equal(observed.stage.coverage.complete, true, JSON.stringify(observed.stage.coverage.gaps));
        assert.equal(observed.nativeBindings[0].expected.registryStateVersion, 0);
        assert.equal(observed.nativeBindings[0].expected.documentSequence, 0);
        assert.equal(observed.nativeBindings[0].expected.binaryHash, digest(target.binary));
      });
      await fixture(`${representation}: missing projection retains exact D1/L1 native CAS, byte profile and inventory`, async () => {
        const target = await seed(undefined, representation), observed = await read();
        assert.equal(observed.stage.coverage.complete, true, JSON.stringify(observed.stage.coverage.gaps));
        assert.equal(observed.stage.executionReady, false); assert.equal(observed.stage.readiness, 'native-coordinator-required');
        const headers = trace.filter(entry => entry.sql.includes('LEFT JOIN file_collaboration_lineages'));
        assert.equal(headers.length, 2, 'both independent passes read a single registry/lineage/state header');
        assert(headers.every(entry => entry.sql.includes('octet_length(s.yjs_state)') && entry.sql.includes('octet_length(s.state_vector)')
          && !/s\.\*|s\.yjs_state\s+AS|s\.state_vector\s+AS/iu.test(entry.sql)), 'header queries expose lengths, never binary payloads');
        assert.equal(trace.filter(entry => entry.sql.startsWith('WITH expected AS MATERIALIZED')).length, 2,
          'both independent passes retain their own bounded binary read');
        assert.equal(observed.nativeBindings.length, 1); assert.equal(observed.privateNativeStates.length, 1);
        const binding = observed.nativeBindings[0], state = observed.privateNativeStates[0];
        assert.equal(binding.expected.documentId, target.documentId); assert.equal(binding.expected.lineageId, target.lineageId);
        assert.equal(binding.expected.registryStateVersion, 7); assert.equal(binding.expected.lifecycleGeneration, 3);
        assert.equal(binding.expected.documentSequence, 7); assert.equal(binding.expected.persistedAt, 100);
        assert.equal(binding.expected.binaryHash, digest(target.binary)); assert.equal(binding.expected.vectorHash, digest(target.vector));
        assert.equal(binding.registry.customerId, null); assert.equal(binding.lineage.customerId, null);
        assert.equal(binding.registry.projectId, null); assert.equal(binding.lineage.projectId, null);
        assert.deepEqual(binding.byteProfile, { newlineStyle: 'crlf', hasBom: true });
        assert.equal(binding.expected.path, ' note .md'); assert.equal(binding.registry.path, binding.expected.path);
        assert.equal(binding.lineage.lineageId, target.lineageId); assert.equal(binding.lineage.archivedAt, null);
        assert.equal(observed.stage.namespace[0].filesystemIdentity, null);
        assert.equal(binding.inventoryProof, nativeLinkJsonProof(observed.stage.sources[0].inventory));
        assert.equal(binding.expected.stateProof, observed.stage.sources[0].kind === 'native' && observed.stage.sources[0].inventory.version.stateProof);
        assert.deepEqual(state.yjsState, target.binary); assert.deepEqual(state.stateVector, target.vector);
        assert(Object.isFrozen(binding)); assert(Object.isFrozen(binding.expected)); assert(Object.isFrozen(binding.registry));
        assert(Object.isFrozen(binding.lineage)); assert(Object.isFrozen(binding.byteProfile));
        assert.deepEqual(JSON.parse(JSON.stringify(binding)), binding);
        assert(!/yjsState|stateVector|canonicalHash|serializedHash/u.test(JSON.stringify(binding)));
      });
    }
    await fixture('actual legacy NULL customer/project pins remain NULL in a scoped project workspace', async () => {
      await seed();
      await sql.exec("UPDATE collaboration_documents SET workspace_type='project',organization_id='org'; UPDATE file_collaboration_lineages SET workspace_type='project',organization_id='org'; UPDATE collaboration_yjs_states SET organization_id='org'");
      const scoped = { ...workspace, workspaceType: 'project' as const, organizationId: 'org', customerId: 'customer', projectId: 'project' };
      const observed = await readWorkspaceLinkSourceAuthorityOnConnection(connection, scoped);
      assert.equal(observed.stage.coverage.complete, true, JSON.stringify(observed.stage.coverage.gaps));
      assert.equal(observed.nativeBindings[0].registry.customerId, null); assert.equal(observed.nativeBindings[0].lineage.projectId, null);
      assert.equal(observed.nativeBindings[0].registry.organizationId, 'org');
    });
    await fixture('legal unexportable table widths remain native and physical inbound graph coverage remains complete', async () => {
      const target = await seed('native.bin', 'tiptap_blocks', { text: '| Keep |\n| --- |\n| [Incoming](incoming.md) |', prepare(doc) {
        const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
        for (const record of tree.records.values()) if (['tableCell', 'tableHeader'].includes((record.get('shape') as { type: string }).type)) {
          (record.get('attributes') as Y.Map<unknown>).set('colwidth', [120]);
        }
        assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
      } });
      await fs.writeFile(path.join(root, 'native.bin'), new Uint8Array([255, 0, 254]));
      await fs.writeFile(path.join(root, 'incoming.md'), '[Native](native.bin)');
      const physical: string[] = [];
      const observed = await readWorkspaceLinkSourceAuthorityOnConnection(connection, workspace,
        { afterSourceFingerprint: async filePath => { physical.push(filePath); } });
      assert.equal(observed.stage.coverage.complete, true, JSON.stringify(observed.stage.coverage.gaps));
      assert.deepEqual(physical, ['incoming.md']); assert.equal(observed.nativeBindings[0].expected.binaryHash, digest(target.binary));
      const effects = previewStagedWorkspaceLinkEffects(observed.stage, { kind: 'delete', sourcePath: 'native.bin' });
      assert.equal(effects.effects.length, 1); assert.equal(effects.effects[0].sourcePath, 'incoming.md');
      assert.equal(effects.effects[0].sourceEvidence.kind, 'physical'); assert.equal(effects.executionReady, false);
      assert.equal(observed.stage.sources.filter(source => source.kind === 'native').length, 1);
    });
    for (const mutation of ["UPDATE collaboration_documents SET lineage_id=NULL", "DELETE FROM file_collaboration_lineages",
      "UPDATE file_collaboration_lineages SET workspace_id='foreign'", "UPDATE file_collaboration_lineages SET organization_id='foreign'",
      "UPDATE file_collaboration_lineages SET customer_id='foreign'", "UPDATE collaboration_documents SET project_id='foreign'"]) {
      await fixture(`actual registry/lineage conflict: ${mutation.split(' SET ')[0]}`, async () => {
        await seed(); await sql.exec(mutation);
        const observed = await read(); assert.equal(observed.stage.coverage.complete, false);
        assert.equal(observed.nativeBindings.length, 0); assert.equal(observed.privateNativeStates.length, 0);
        assert(observed.stage.coverage.gaps.some(gap => gap.code === 'native-identity-conflict'));
      });
    }
    for (const mutation of ["UPDATE collaboration_yjs_states SET has_bom=2", "UPDATE collaboration_yjs_states SET degraded=2",
      "UPDATE collaboration_yjs_states SET projection_error_permanent=1", "UPDATE collaboration_yjs_states SET projection_error_permanent=2"]) {
      await fixture(`raw flags reject before blob/loader: ${mutation.split(' SET ')[1]}`, async () => {
        const target = await seed(); await sql.exec(mutation); let loads = 0;
        const observed = await readWorkspaceLinkSourceAuthorityOnConnection(connection, workspace,
          { loadState: async () => { loads++; throw new Error('must not execute'); } });
        assert.equal(observed.stage.coverage.complete, false); assert.equal(observed.nativeBindings.length, 0); assert.equal(loads, 0);
        assert(!trace.some(entry => entry.sql.startsWith('WITH expected AS MATERIALIZED') && (entry.values[0] as string[]).includes(target.documentId)));
      });
    }
    await fixture('classified nonpermanent persistence retry retains its real bytes and positive flags', async () => {
      const target = await seed();
      await sql.query(`UPDATE collaboration_yjs_states SET degraded=1,projection_error_code=$1,projection_error_sequence=7,
        projection_error_generation=3,projection_error_phase='persist',projection_error_permanent=0`, [COLLABORATION_FAILURE_CODES.persistenceFailed]);
      const observed = await read(); assert.equal(observed.stage.coverage.complete, true);
      assert.equal(observed.privateNativeStates[0].degraded, true); assert.equal(observed.privateNativeStates[0].hasBom, true);
      assert.equal(observed.privateNativeStates[0].projectionError?.permanent, false);
      assert.equal(observed.nativeBindings[0].expected.binaryHash, digest(target.binary));
    });
    for (const mutation of ["UPDATE collaboration_yjs_states SET degraded=1",
      "UPDATE collaboration_yjs_states SET projection_error_code='failure',projection_error_sequence=7,projection_error_generation=3,projection_error_permanent=1"]) {
      await fixture('quarantine is rejected without fallback or fabricated native state', async () => {
        await seed(); await sql.exec(mutation); const observed = await read();
        assert.equal(observed.stage.coverage.complete, false); assert.equal(observed.nativeBindings.length, 0);
        assert.equal(observed.privateNativeStates.length, 0); assert.equal(observed.stage.sources.length, 0);
      });
    }
    for (const bound of ['source', 'vector', 'aggregate'] as const) await fixture(`${bound} byte budget rejects before full binary fetch`, async () => {
      const target = await seed();
      const byteLength = target.binary.byteLength + target.vector.byteLength;
      if (bound === 'vector') await sql.query('UPDATE collaboration_yjs_states SET state_vector=$1', [new Uint8Array(1024*1024+1)]);
      const observed = await readWorkspaceLinkSourceAuthorityOnConnection(connection, workspace, {
        limits: bound === 'source' ? { maxSourceBytes: target.binary.byteLength-1 }
          : bound === 'aggregate' ? { maxTotalSourceBytes: byteLength-1 } : {},
      });
      assert.equal(observed.stage.coverage.complete, false); assert(observed.stage.coverage.gaps.some(gap => gap.code === 'source-byte-limit'));
      assert(!trace.some(entry => entry.sql.startsWith('WITH expected AS MATERIALIZED')));
    });
    await fixture('raw schema is checked against actual XML and block operations before inventory acceptance', async () => {
      await seed('xml.md', 'tiptap_xml', { prepare(doc) {
        (doc.getXmlFragment('body').toArray()[0] as Y.XmlElement).setAttribute('futureAttr', 'hidden');
      } });
      await seed('blocks.md', 'tiptap_blocks', { prepare(doc) {
        const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
        tree.move({ blockId: [...tree.records.keys()][0], parentId: null, beforeId: null, operationId: 'future-operation' }, 'fixture');
        const operation = tree.operations.get('future-operation'); assert(operation);
        tree.operations.set(operation.id, { ...operation, futureField: true } as unknown as typeof operation);
      } });
      const observed = await read(); assert.equal(observed.stage.coverage.complete, false);
      assert.equal(observed.nativeBindings.length, 0); assert.equal(observed.privateNativeStates.length, 0);
    });
    await fixture('metadata-to-binary drift rejects a different genuine raw row', async () => {
      const target = await seed(); let changed = false;
      beforeQuery = async statement => { if (!changed && statement.startsWith('WITH expected AS MATERIALIZED')) {
        changed = true; await sql.query('UPDATE collaboration_yjs_states SET has_bom=0 WHERE document_id=$1', [target.documentId]);
      } };
      const observed = await read(); assert.equal(changed, true); assert.equal(observed.stage.coverage.complete, false);
      assert.equal(observed.nativeBindings.length, 0);
    });
    for (const drift of ['lineage', 'native', 'checkpoint', 'membership'] as const) await fixture(`final ${drift} drift invalidates all observation payloads`, async () => {
      const target = await seed(); await fs.writeFile(path.join(root, 'incoming.md'), '[Target]( note .md)');
      const observed = await readWorkspaceLinkSourceAuthorityOnConnection(connection, workspace, { afterSourceFingerprint: async () => {
        if (drift === 'lineage') await sql.query("UPDATE file_collaboration_lineages SET trash_entry_id='new-history' WHERE id=$1", [target.lineageId]);
        else if (drift === 'membership') await seed('added.md');
        else if (drift === 'checkpoint') await sql.query('UPDATE collaboration_yjs_states SET checkpoint_sequence=1,checkpointed_at=100 WHERE document_id=$1', [target.documentId]);
        else await sql.query('UPDATE collaboration_yjs_states SET document_sequence=8 WHERE document_id=$1', [target.documentId]);
      } });
      assert.equal(observed.stage.coverage.complete, false); assert.equal(observed.stage.sources.length, 0);
      assert.equal(observed.nativeBindings.length, 0); assert.equal(observed.privateNativeStates.length, 0);
      assert(observed.stage.coverage.gaps.some(gap => gap.code === (drift === 'membership' ? 'source-authority-changed' : 'native-source-changed')));
    });
    await fixture('legacy load hook cannot replace actual SQL bytes or supply a missing native source', async () => {
      const target = await seed(); const raw = (await sql.query<Record<string, unknown>>('SELECT * FROM collaboration_yjs_states')).rows[0];
      const state = await mapValidatedNativeStateRow(raw, target.documentId); assert(state);
      const observed = await readWorkspaceLinkSourceAuthorityOnConnection(connection, workspace,
        { loadState: async () => ({ ...state, documentSequence: state.documentSequence+1 }) });
      assert.equal(observed.stage.coverage.complete, false); assert.equal(observed.nativeBindings.length, 0);
      assert(observed.stage.coverage.gaps.some(gap => gap.code === 'native-source-changed'));
      const mutated = await readWorkspaceLinkSourceAuthorityOnConnection(connection, workspace, { loadState: async (database, documentId) => {
        const candidate = await database.get('SELECT * FROM collaboration_yjs_states WHERE document_id = $1 LIMIT 1', [documentId]) as Record<string, unknown>;
        (candidate.yjs_state as Uint8Array)[0] ^= 1;
        return mapValidatedNativeStateRow(candidate, documentId);
      } });
      assert.equal(mutated.stage.coverage.complete, false); assert.equal(mutated.nativeBindings.length, 0);
      assert(mutated.stage.coverage.gaps.some(gap => gap.code === 'native-source-changed'));
      assert.deepEqual((await sql.query<{ yjs_state: Uint8Array }>('SELECT yjs_state FROM collaboration_yjs_states WHERE document_id=$1', [target.documentId])).rows[0].yjs_state, target.binary);
      await sql.exec('DELETE FROM collaboration_yjs_states');
      const missing = await readWorkspaceLinkSourceAuthorityOnConnection(connection, workspace, { loadState: async () => state });
      assert.equal(missing.stage.coverage.complete, false); assert.equal(missing.privateNativeStates.length, 0);
    });
  } finally {
    beforeQuery = undefined; await sql.exec('ROLLBACK').catch(() => undefined);
    await sql.close(); await fs.rm(root, { recursive: true, force: true });
  }
});
