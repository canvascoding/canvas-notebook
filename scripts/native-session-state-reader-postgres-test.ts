import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client, Pool } from 'pg';
import { getSchema } from '@tiptap/core';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { createPlainTextYDoc, createRichMarkdownYDoc, richMarkdownSchemaExtensions, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { withExistingNativeCollaborationSessionOnConnection as readSession,
  assertExistingNativeCollaborationSessionCurrentOnConnection as current,
  inspectExistingNativeCollaborationSessionOnConnection as inspect,
  type ExistingNativeCollaborationSession, type ExistingNativeSessionIdentity } from '../app/lib/collaboration/native-session-state-reader';
import { withWorkspaceFileLifecycleLeases } from '../app/lib/collaboration/file-lifecycle-admission-context';
import { createCollaborationAdmissionService } from '../app/lib/collaboration/room-admission';
import { collaborationAdmissionActionDigest, collaborationAdmissionLockKey } from '../app/lib/collaboration/room-admission-contract';
import { createCollaborationRoomOwnerSession } from '../app/lib/collaboration/room-owner';
import { Y } from '../app/lib/collaboration/server-runtime';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';

let stage = 'private managed environment'; let completed = 0;
const code = (value: string) => (error: unknown) => (error as { code?: string })?.code === value;

async function main() {
  assert.equal(process.env.NODE_ENV, 'test');
  const envPath = process.env.CANVAS_NATIVE_SESSION_READER_TEST_ENV_FILE; assert(envPath);
  assert.equal((await stat(envPath)).mode & 0o077, 0);
  const connectionString = parse(await readFile(envPath)).DATABASE_URL; assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol)); assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, '');
  const schema = `canvas_native_session_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^canvas_native_session_[a-f0-9]{32}$/u); assert(schema.length <= 63);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'canvas-native-session-'));
  const previousData = process.env.CANVAS_DATA_ROOT; process.env.CANVAS_DATA_ROOT = temporaryRoot;
  const control = new Client({ connectionString, connectionTimeoutMillis: 5000, options: '-c statement_timeout=15000' });
  const clients = new Set<Client>(); let pool: Pool | undefined; let created = false;
  const newClient = async () => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=2000 -c application_name=canvas-native-session-test` });
    client.on('error', () => undefined); clients.add(client); await client.connect(); return client;
  };
  const traces = new WeakMap<SqlConnection, string[]>();
  const adapt = (client: Client): SqlConnection => {
    const trace: string[] = [];
    const query = (sql: string, values?: unknown[]) => { trace.push(sql); return client.query(sql, values); };
    const db: SqlConnection = { get: async (sql, values) => (await query(sql, values)).rows[0],
      all: async (sql, values) => (await query(sql, values)).rows, run: async (sql, values) => ({ changes: (await query(sql, values)).rowCount ?? 0 }),
      close: async () => { await client.end(); clients.delete(client); } };
    traces.set(db, trace); return db;
  };
  const openConnection = async () => adapt(await newClient());
  const workspace: WorkspaceContext = { workspaceId: `session-${randomUUID()}`, workspaceType: 'personal', organizationId: null,
    rootPath: path.join(temporaryRoot, 'deliberately-absent-root'), legacy: false, status: 'active', actor: { userId: 'session-fixture-owner', role: 'owner' },
    permissions: { canRead: true, canWrite: true, canDelete: true, canManageWorkspace: true, canCreatePublicLinks: true, canRunAgent: true } };
  const transaction = async <T>(operation: (db: SqlConnection) => Promise<T>, begin = 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY'): Promise<T> => {
    const db = await openConnection();
    try { await db.run(begin); const result = await operation(db); await db.run('COMMIT'); return result; }
    catch (error) { await Promise.resolve(db.run('ROLLBACK')).catch(() => undefined); throw error; }
    finally { await db.close(); }
  };
  const fixture = async (name: string, test: () => Promise<void>) => { stage = name; await test(); completed += 1; console.log(`ok ${completed} - ${name}`); };
  try {
    await control.connect();
    const server = (await control.query(`SELECT current_database() AS name,current_setting('server_version_num')::integer AS version,
      to_regclass('public.collaboration_yjs_states') IS NOT NULL AS states`)).rows[0];
    assert.equal(server.name, 'canvas_notebook'); assert.equal(Math.floor(server.version / 10000), 18); assert.equal(server.states, true);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    for (const table of ['file_collaboration_lineages', 'collaboration_documents', 'collaboration_yjs_states',
      'collaboration_admission_requests', 'collaboration_admission_scopes', 'collaboration_admission_targets']) {
      await control.query(`CREATE TABLE "${schema}".${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=2000` });
    const seed = async (filePath: string, representation: ExistingNativeSessionIdentity['representation'] = 'plain_text',
      options: { doc?: InstanceType<typeof Y.Doc>; content?: string; sequence?: number; hasBom?: boolean; crlf?: boolean; context?: WorkspaceContext } = {}) => {
      const context = options.context ?? workspace, documentId = `doc-${randomUUID()}`, lineageId = `lineage-${randomUUID()}`;
      const doc = options.doc ?? (representation === 'plain_text' ? createPlainTextYDoc(options.content ?? 'Authoritative native body')
        : createRichMarkdownYDoc(options.content ?? '# Authoritative native body\n', representation));
      const update = Buffer.from(Y.encodeStateAsUpdate(doc)), vector = Buffer.from(Y.encodeStateVector(doc));
      const proof = collaborationStateProof(doc, Y); if (!options.doc) doc.destroy();
      const sequence = options.sequence ?? 7;
      await pool!.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
        VALUES($1,$2,$3,$4,$5,'active',100)`, [lineageId, context.workspaceId, context.workspaceType, context.organizationId ?? null, filePath]);
      await pool!.query(`INSERT INTO collaboration_documents(id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,
        state_version,yjs_state_lifecycle,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'yjs',$7,'initialized','active',100,100)`,
      [documentId, lineageId, context.workspaceId, context.workspaceType, context.organizationId ?? null, filePath, sequence]);
      await pool!.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,
        yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence,checkpointed_at,canonical_hash,serialized_hash,newline_style,has_bom,degraded,status)
        VALUES($1,$2,$3,$4,$5,1,1,$6,$7,$8,100,0,NULL,NULL,NULL,$9,$10,0,'active')`,
      [documentId, context.workspaceId, context.organizationId ?? null, filePath, representation, update, vector, sequence,
        options.crlf ? 'crlf' : 'lf', options.hasBom ? 1 : 0]);
      const identity: ExistingNativeSessionIdentity = { documentId, lineageId, workspaceId: context.workspaceId,
        organizationId: context.organizationId ?? null, path: filePath, lifecycleGeneration: 1, representation, schemaVersion: 1 };
      return { identity, update, vector, proof };
    };
    const bytes = async (target: ExistingNativeSessionIdentity) => (await pool!.query(`SELECT yjs_state,state_vector,document_sequence,
      canonical_hash,serialized_hash FROM collaboration_yjs_states WHERE document_id=$1`, [target.documentId])).rows[0];
    const inputFor = (identity: ExistingNativeSessionIdentity, context = workspace) => ({ workspace: context, path: identity.path, expectedIdentity: identity });

    await fixture('existing Plain/XML/Blocks and empty native seeds need no physical root', async () => {
      for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) for (const empty of [false, true]) {
        const seeded = await seed(`${representation}-${empty}.md`, representation, { content: empty ? '' : undefined, sequence: empty ? 0 : 7 });
        await transaction(db => readSession(db, inputFor(seeded.identity), async cap => {
          const snapshot = await current(db, cap);
          assert.equal(snapshot.documentId, seeded.identity.documentId); assert.equal(snapshot.stateProof, seeded.proof);
          assert.equal(snapshot.stateVector, seeded.vector.toString('base64')); assert.equal(snapshot.representation, representation);
          assert.equal(snapshot.documentSequence, empty ? 0 : 7); assert(!('projectionFinalized' in snapshot));
          assert(!/yjsState|canonicalHash|serializedHash|content|frontmatter/u.test(JSON.stringify(snapshot)));
          assert.equal(inspect(db, cap, native => native.content.kind), representation === 'plain_text' ? 'plain_text' : 'rich_text');
        }));
        assert.deepEqual((await bytes(seeded.identity)).yjs_state, seeded.update);
      }
    });
    await fixture('BOM/CRLF/frontmatter-only XML and real deletion history stay native', async () => {
      const metadata = await seed('metadata-only.markdown', 'tiptap_xml', { content: '---\ntitle: Retained\n---\n\n', sequence: 0, hasBom: true, crlf: true });
      await transaction(db => readSession(db, inputFor(metadata.identity), async cap => {
        const snapshot = await current(db, cap); assert.equal(snapshot.hasBom, true); assert.equal(snapshot.newlineStyle, 'crlf');
        inspect(db, cap, native => { assert.equal(native.content.kind, 'rich_text'); if (native.content.kind === 'rich_text') {
          assert.equal(native.content.frontmatter, '---\ntitle: Retained\n---\n\n'); assert.equal(native.content.bodyFinalLineEnding, '');
          assert.equal(native.content.frontmatter + native.content.bodyFinalLineEnding, '---\ntitle: Retained\n---\n\n');
          assert.deepEqual(native.content.document, { type: 'doc' }); }
        });
      }));
      const doc = createRichMarkdownYDoc('Delete this body', 'tiptap_xml'); doc.getXmlFragment('body').delete(0, doc.getXmlFragment('body').length);
      try { const deleted = await seed('deleted-body.md', 'tiptap_xml', { doc });
        await transaction(db => readSession(db, inputFor(deleted.identity), async cap => { assert.equal((await current(db, cap)).stateProof, deleted.proof); }));
        assert.deepEqual((await bytes(deleted.identity)).yjs_state, deleted.update);
      } finally { doc.destroy(); }
    });
    await fixture('nonprojectable legal table and a stale disk file do not control native sessions', async () => {
      const doc = createRichMarkdownYDoc('| Keep |\n| --- |\n| value |', 'tiptap_blocks');
      try {
        const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
        for (const record of tree.records.values()) if (['tableCell', 'tableHeader'].includes((record.get('shape') as { type: string }).type)) {
          (record.get('attributes') as InstanceType<typeof Y.Map>).set('colwidth', [120]);
        }
        assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
        const seeded = await seed('native-only.txt', 'tiptap_blocks', { doc });
        await writeFile(path.join(temporaryRoot, 'native-only.txt'), 'Stale physical content');
        await pool!.query(`UPDATE collaboration_yjs_states SET projection_error_code='COLLABORATION_ROUNDTRIP_UNSTABLE',
          projection_error_generation=1,projection_error_sequence=7,projection_error_permanent=0 WHERE document_id=$1`, [seeded.identity.documentId]);
        await transaction(db => readSession(db, inputFor(seeded.identity), async cap => {
          const snapshot = await current(db, cap); assert.equal(snapshot.representation, 'tiptap_blocks');
          assert.equal(snapshot.projectionError?.permanent, false); assert.equal(snapshot.stateProof, seeded.proof);
          assert(inspect(db, cap, native => JSON.stringify(native.content).includes('colwidth')));
        }));
        assert.equal(await readFile(path.join(temporaryRoot, 'native-only.txt'), 'utf8'), 'Stale physical content');
        assert.deepEqual((await bytes(seeded.identity)).yjs_state, seeded.update);
      } finally { doc.destroy(); }
    });
    await fixture('significant spaces select the exact native identity; unsupported suffixes fail', async () => {
      const exact = await seed(' folder / note.md'), trimmed = await seed('folder/note.md');
      await transaction(db => readSession(db, inputFor(exact.identity), async cap => { assert.equal((await current(db, cap)).documentId, exact.identity.documentId); }));
      assert.notEqual(exact.identity.documentId, trimmed.identity.documentId);
      for (const filePath of ['bad.docx', 'bad.md ', '../bad.md', 'bad\\note.md']) {
        await assert.rejects(transaction(db => readSession(db, { workspace, path: filePath }, async () => undefined)), code('NATIVE_SESSION_INVALID'));
      }
    });
    await fixture('read-only context is readable; unreadable/legacy contexts grant no capability', async () => {
      const seeded = await seed('rights.md');
      const readOnly = { ...workspace, permissions: { ...workspace.permissions, canWrite: false } };
      await transaction(db => readSession(db, inputFor(seeded.identity, readOnly), async cap => { assert.equal((await current(db, cap)).documentId, seeded.identity.documentId); }));
      for (const context of [{ ...workspace, legacy: true }, { ...workspace, permissions: { ...workspace.permissions, canRead: false } }]) {
        await assert.rejects(transaction(db => readSession(db, inputFor(seeded.identity, context), async () => undefined)), code('NATIVE_SESSION_INVALID'));
      }
    });
    await fixture('missing/pristine/historical state never initializes or changes registry rows', async () => {
      for (const marker of ['never_initialized', 'initialized', 'legacy_unknown']) {
        const seeded = await seed(`${marker}.md`);
        await pool!.query('DELETE FROM collaboration_yjs_states WHERE document_id=$1', [seeded.identity.documentId]);
        await pool!.query('UPDATE collaboration_documents SET yjs_state_lifecycle=$2,state_version=0 WHERE id=$1', [seeded.identity.documentId, marker]);
        const before = (await pool!.query('SELECT * FROM collaboration_documents WHERE id=$1', [seeded.identity.documentId])).rows[0];
        await assert.rejects(transaction(db => readSession(db, inputFor(seeded.identity), async () => undefined)), code('NATIVE_SESSION_STATE_MISSING'));
        assert.equal(await bytes(seeded.identity), undefined);
        assert.deepEqual((await pool!.query('SELECT * FROM collaboration_documents WHERE id=$1', [seeded.identity.documentId])).rows[0], before);
      }
    });
    await fixture('identity expectations, organization and live lineage are exact', async () => {
      const organizationWorkspace = { ...workspace, workspaceId: `organization-${randomUUID()}`, workspaceType: 'organization' as const, organizationId: 'fixture-organization' };
      const seeded = await seed('organization.md', 'plain_text', { context: organizationWorkspace });
      for (const changed of [{ documentId: 'another-document' }, { lineageId: 'another-lineage' }, { lifecycleGeneration: 2 }, { representation: 'tiptap_xml' as const }]) {
        await assert.rejects(transaction(db => readSession(db, { ...inputFor(seeded.identity, organizationWorkspace),
          expectedIdentity: { ...seeded.identity, ...changed } }, async () => undefined)), code('NATIVE_SESSION_SCOPE_CHANGED'));
      }
      await assert.rejects(transaction(db => readSession(db, { workspace: { ...organizationWorkspace, organizationId: 'wrong-organization' }, path: seeded.identity.path }, async () => undefined)), code('NATIVE_SESSION_SCOPE_CHANGED'));
      await pool!.query("UPDATE file_collaboration_lineages SET status='archived',archived_at=101,trash_entry_id='fixture-trash' WHERE id=$1", [seeded.identity.lineageId]);
      await assert.rejects(transaction(db => readSession(db, inputFor(seeded.identity, organizationWorkspace), async () => undefined)), code('NATIVE_SESSION_SCOPE_CHANGED'));
    });
    await fixture('peer sequence/delete progress is adopted without a lifecycle conflict', async () => {
      const doc = createPlainTextYDoc('ABC');
      try { const seeded = await seed('peer-edits.md', 'plain_text', { doc });
        await transaction(db => readSession(db, inputFor(seeded.identity), async cap => {
          const before = cap.snapshot; doc.getText('content').delete(0, 1);
          await pool!.query('UPDATE collaboration_yjs_states SET yjs_state=$2,state_vector=$3,document_sequence=8,persisted_at=101 WHERE document_id=$1',
          [seeded.identity.documentId, Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc))]);
          const after = await current(db, cap); assert.equal(after.stateVector, before.stateVector); assert.notEqual(after.stateProof, before.stateProof);
          assert.equal(after.documentSequence, 8); assert.equal(after.lifecycleGeneration, 1);
          inspect(db, cap, native => { assert.equal(native.content.kind, 'plain_text'); if (native.content.kind === 'plain_text') assert.equal(native.content.text, 'BC'); });
        }));
      } finally { doc.destroy(); }
    });
    await fixture('disappearing state and generation drift remain fatal when caught', async () => {
      const missing = await seed('disappearing.md');
      await assert.rejects(transaction(db => readSession(db, inputFor(missing.identity), async cap => {
        await pool!.query('DELETE FROM collaboration_yjs_states WHERE document_id=$1', [missing.identity.documentId]);
        await assert.rejects(current(db, cap), code('NATIVE_SESSION_STATE_MISSING'));
      })), code('NATIVE_SESSION_STATE_MISSING')); assert.equal(await bytes(missing.identity), undefined);
      const changed = await seed('generation-drift.md');
      await assert.rejects(transaction(db => readSession(db, inputFor(changed.identity), async cap => {
        await pool!.query('UPDATE collaboration_yjs_states SET lifecycle_generation=2 WHERE document_id=$1', [changed.identity.documentId]);
        await assert.rejects(current(db, cap), code('NATIVE_SESSION_SCOPE_CHANGED'));
      })), code('NATIVE_SESSION_SCOPE_CHANGED'));
    });
    await fixture('corrupt binary/vector, unknown native attributes/roots and pending updates reject', async () => {
      for (const variant of ['vector', 'suffix', 'xml-attribute', 'xml-mark', 'blocks-attribute', 'blocks-record',
        'blocks-operation', 'blocks-mark', 'unknown-root', 'pending'] as const) {
        stage = `native corruption: ${variant}`;
        const representation = variant.startsWith('blocks-') ? 'tiptap_blocks' : variant.startsWith('xml-') ? 'tiptap_xml' : 'plain_text';
        const doc = variant === 'xml-attribute' ? createRichMarkdownYDoc('Raw schema', 'tiptap_xml') : representation === 'plain_text'
          ? createPlainTextYDoc('Raw native text') : createRichMarkdownYDoc('Raw [link](target.md)', representation);
        try {
          if (variant === 'xml-attribute') (doc.getXmlFragment('body').toArray()[0] as InstanceType<typeof Y.XmlElement>).setAttribute('unknown-future-attr', 'private');
          if (variant.startsWith('blocks-')) {
            const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions())), record = [...tree.records.values()][0];
            if (variant === 'blocks-attribute') (record.get('attributes') as InstanceType<typeof Y.Map>).set('futureField', 'private');
            if (variant === 'blocks-record') record.set('futureField', 'private');
            if (variant === 'blocks-operation') tree.operations.set('future-op', { id: 'future-op', clock: 1, actor: 1, transactionId: 'fixture-tx',
              ordinal: 0, kind: 'move', blockId: [...tree.records.keys()][0], parentId: null, beforeId: null, futureField: 'private' } as never);
          }
          if (variant === 'xml-mark' || variant === 'blocks-mark') {
            let marked = false;
            const visit = (fragment: InstanceType<typeof Y.XmlFragment>) => {
              for (const child of fragment.toArray()) {
                if (child instanceof Y.XmlText) {
                  for (const part of child.toDelta()) if (part.attributes?.link) {
                    child.format(0, child.length, { link: { ...part.attributes.link, futureField: 'private' } }); marked = true;
                  }
                } else if (child instanceof Y.XmlElement) visit(child);
              }
            };
            if (representation === 'tiptap_xml') visit(doc.getXmlFragment('body'));
            else for (const record of new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions())).records.values()) {
              visit(record.get('content') as InstanceType<typeof Y.XmlFragment>);
            }
            assert.equal(marked, true, 'real native link mark must be injected');
          }
          if (variant === 'unknown-root') doc.getMap('unknown-root').set('hidden', 'private');
          const seeded = await seed(`invalid-${variant}.md`, representation, { doc });
          if (variant === 'vector') await pool!.query('UPDATE collaboration_yjs_states SET state_vector=$2 WHERE document_id=$1', [seeded.identity.documentId, Buffer.from([0])]);
          if (variant === 'suffix') await pool!.query('UPDATE collaboration_yjs_states SET yjs_state=$2 WHERE document_id=$1', [seeded.identity.documentId, Buffer.concat([seeded.update, Buffer.from([0])])]);
          if (variant === 'pending') {
            const vector = Y.encodeStateVector(doc); doc.getText('content').insert(doc.getText('content').length, 'pending');
            const fresh = new Y.Doc(); try { Y.applyUpdate(fresh, Y.encodeStateAsUpdate(doc, vector)); assert(fresh.store.pendingStructs);
              await pool!.query('UPDATE collaboration_yjs_states SET yjs_state=$2,state_vector=$3 WHERE document_id=$1',
              [seeded.identity.documentId, Buffer.from(Y.encodeStateAsUpdate(fresh)), Buffer.from(Y.encodeStateVector(fresh))]);
            } finally { fresh.destroy(); }
          }
          const before = await bytes(seeded.identity);
          await assert.rejects(transaction(db => readSession(db, inputFor(seeded.identity), async () => undefined)), code('NATIVE_SESSION_STATE_INVALID'));
          assert.deepEqual(await bytes(seeded.identity), before);
        } finally { doc.destroy(); }
      }
    });
    await fixture('permanent/legacy quarantine and invalid stored flag reject without clearing', async () => {
      for (const variant of ['permanent', 'legacy', 'invalid'] as const) {
        const seeded = await seed(`quarantine-${variant}.md`);
        await pool!.query(variant === 'permanent' ? `UPDATE collaboration_yjs_states SET projection_error_code='COLLABORATION_SCHEMA_INVALID',
          projection_error_generation=1,projection_error_sequence=7,projection_error_permanent=1 WHERE document_id=$1`
          : 'UPDATE collaboration_yjs_states SET degraded=$2 WHERE document_id=$1',
        variant === 'permanent' ? [seeded.identity.documentId] : [seeded.identity.documentId, variant === 'legacy' ? 1 : 2]);
        await assert.rejects(transaction(db => readSession(db, inputFor(seeded.identity), async () => undefined)),
          code(variant === 'invalid' ? 'NATIVE_SESSION_STATE_INVALID' : 'NATIVE_SESSION_QUARANTINED'));
      }
    });
    await fixture('caller-owned RC READ ONLY required; autocommit and wrong isolation reject', async () => {
      const seeded = await seed('transaction-mode.md');
      for (const begin of ['BEGIN', 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY']) {
        await assert.rejects(transaction(db => readSession(db, inputFor(seeded.identity), async () => undefined), begin), code('NATIVE_SESSION_SCOPE_CHANGED'));
      }
      const db = await openConnection(); try { await db.run('SET default_transaction_read_only=on');
        await assert.rejects(readSession(db, inputFor(seeded.identity), async () => undefined), code('NATIVE_SESSION_SCOPE_CHANGED'));
      } finally { await db.close(); }
    });
    await fixture('wrong connection, wrapper, retained and forged capability cannot authorize', async () => {
      const seeded = await seed('private-capability.md'); let retained!: ExistingNativeCollaborationSession;
      await transaction(db => readSession(db, inputFor(seeded.identity), async cap => { retained = cap; await current(db, cap); }));
      assert.throws(() => retained.snapshot, code('NATIVE_SESSION_REQUIRED'));
      await transaction(async db => { await assert.rejects(current(db, retained), code('NATIVE_SESSION_REQUIRED')); });
      for (const method of ['current', 'inspect']) await assert.rejects(transaction(db => readSession(db, inputFor(seeded.identity), async () => {
        if (method === 'current') await assert.rejects(current(db, retained), code('NATIVE_SESSION_REQUIRED'));
        else assert.throws(() => inspect(db, retained, () => undefined), code('NATIVE_SESSION_REQUIRED'));
      })), code('NATIVE_SESSION_REQUIRED'));
      await assert.rejects(transaction(db => readSession(db, inputFor(seeded.identity), async cap => {
        await assert.rejects(current({ ...db }, cap), code('NATIVE_SESSION_REQUIRED'));
      })), code('NATIVE_SESSION_REQUIRED'));
      await assert.rejects(transaction(db => readSession(db, inputFor(seeded.identity), async cap => {
        await assert.rejects(current(db, Object.freeze({ snapshot: cap.snapshot })), code('NATIVE_SESSION_REQUIRED'));
      })), code('NATIVE_SESSION_REQUIRED'));
      const other = await openConnection();
      try {
        await other.run('BEGIN READ ONLY');
        await assert.rejects(transaction(db => readSession(db, inputFor(seeded.identity), async cap => {
          await assert.rejects(current(other, cap), code('NATIVE_SESSION_REQUIRED'));
        })), code('NATIVE_SESSION_REQUIRED'));
        await assert.rejects(transaction(db => readSession(db, inputFor(seeded.identity), async cap => {
          const originalGet = db.get, originalAll = db.all;
          db.get = other.get; db.all = other.all;
          try { await assert.rejects(current(db, cap), code('NATIVE_SESSION_SCOPE_CHANGED')); }
          finally { db.get = originalGet; db.all = originalAll; }
        })), code('NATIVE_SESSION_SCOPE_CHANGED'));
      } finally { await Promise.resolve(other.run('ROLLBACK')).catch(() => undefined); await other.close(); }
    });
    await fixture('new XID and searchpath changes poison the callback', async () => {
      const seeded = await seed('connection-drift.md');
      for (const drift of ['transaction', 'schema']) await assert.rejects(transaction(db => readSession(db, inputFor(seeded.identity), async cap => {
        if (drift === 'transaction') { await db.run('COMMIT'); await db.run('BEGIN READ ONLY'); }
        else await db.run('SET LOCAL search_path=public');
        await assert.rejects(current(db, cap), code('NATIVE_SESSION_SCOPE_CHANGED'));
      })), code('NATIVE_SESSION_SCOPE_CHANGED'));
    });
    await fixture('detached and caught synchronous inspection errors remain fatal', async () => {
      const seeded = await seed('detached.md');
      await assert.rejects(transaction(db => readSession(db, inputFor(seeded.identity), async cap => { void current(db, cap).catch(() => undefined); })), code('NATIVE_SESSION_DETACHED'));
      await assert.rejects(transaction(db => readSession(db, inputFor(seeded.identity), async cap => {
        assert.throws(() => inspect(db, cap, async () => undefined), code('NATIVE_SESSION_INVALID'));
      })), code('NATIVE_SESSION_INVALID'));
    });
    await fixture('real bigint shared lock excludes lifecycle exclusive until caller COMMIT', async () => {
      const seeded = await seed('shared-fence.md'); const rival = await newClient(); const db = await openConnection();
      try { await db.run('BEGIN READ ONLY'); await readSession(db, inputFor(seeded.identity), async cap => {
        await current(db, cap); assert.equal((await rival.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [collaborationAdmissionLockKey(workspace.workspaceId)])).rows[0].locked, false);
      });
        assert.equal((await rival.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [collaborationAdmissionLockKey(workspace.workspaceId)])).rows[0].locked, false);
        await db.run('COMMIT'); assert.equal((await rival.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [collaborationAdmissionLockKey(workspace.workspaceId)])).rows[0].locked, true);
      } finally { await Promise.resolve(db.run('ROLLBACK')).catch(() => undefined); await db.close(); await rival.end(); clients.delete(rival); }
    });
    await fixture('own and foreign exclusive locks or inherited lease fail without waiting', async () => {
      const seeded = await seed('exclusive-busy.md'); const rival = await newClient(); const key = collaborationAdmissionLockKey(workspace.workspaceId);
      try { await rival.query('SELECT pg_advisory_lock($1::bigint)', [key]);
        await assert.rejects(transaction(db => readSession(db, inputFor(seeded.identity), async () => undefined)), code('NATIVE_SESSION_BUSY'));
      } finally { await rival.end(); clients.delete(rival); }
      await assert.rejects(transaction(async db => { await db.get('SELECT pg_advisory_xact_lock($1::bigint)', [key]);
        return readSession(db, inputFor(seeded.identity), async () => undefined);
      }), code('NATIVE_SESSION_REENTRANT'));
      await assert.rejects(withWorkspaceFileLifecycleLeases(new Map([[workspace.workspaceId, { active: true, verify: async () => true }]]),
        () => transaction(db => readSession(db, inputFor(seeded.identity), async () => undefined))), code('NATIVE_SESSION_REENTRANT'));
    });
    await fixture('actual active room owner does not block an ordinary existing session read', async () => {
      const seeded = await seed('active-room.md'); const client = await newClient(); const owner = await createCollaborationRoomOwnerSession(client);
      try { const { lineageId: _lineageId, ...scope } = seeded.identity; await owner.acquire(scope);
        await transaction(db => readSession(db, inputFor(seeded.identity), async cap => { await current(db, cap); }));
      } finally { await owner.close(); clients.delete(client); }
    });
    await fixture('real persisted admission reservation blocks the native session reader', async () => {
      const seeded = await seed('reserved.md'); const admission = createCollaborationAdmissionService({ openConnection });
      const { lineageId: _lineageId, ...target } = seeded.identity;
      const actionPayloadText = JSON.stringify({ targetPath: 'reserved-renamed.md' });
      await admission.reserve({ requestId: randomUUID(), actorId: 'fixture-owner', action: 'rename', actionPayloadText,
        actionDigest: collaborationAdmissionActionDigest('rename', actionPayloadText),
        scopes: [{ workspaceId: workspace.workspaceId, organizationId: null, path: seeded.identity.path, kind: 'exact' }],
        expectedDocuments: [{ ...target, status: 'active' }] });
      await assert.rejects(transaction(db => readSession(db, inputFor(seeded.identity), async () => undefined)), code('NATIVE_SESSION_BUSY'));
    });
    await fixture('SQL length bound rejects oversized native state before selecting binary', async () => {
      const seeded = await seed('oversized.md');
      await pool!.query("UPDATE collaboration_yjs_states SET yjs_state=repeat('x',67108865)::bytea WHERE document_id=$1", [seeded.identity.documentId]);
      await transaction(async db => { const start = traces.get(db)!.length;
        await assert.rejects(readSession(db, inputFor(seeded.identity), async () => undefined), code('NATIVE_SESSION_TOO_LARGE'));
        assert(!traces.get(db)!.slice(start).some(sql => /SELECT \* FROM/u.test(sql)));
        assert(traces.get(db)!.slice(start).every(sql => /^\s*SELECT/u.test(sql)));
      });
    });
    console.log(`Native existing-only session reader: ${completed} isolated PostgreSQL 18 / real Yjs fixtures passed; no production activation.`);
  } finally {
    for (const client of clients) await client.end().catch(() => undefined);
    await pool?.end();
    if (created) await control.query(`DROP SCHEMA "${schema}" CASCADE`);
    await control.end().catch(() => undefined); await rm(temporaryRoot, { recursive: true, force: true });
    if (previousData === undefined) delete process.env.CANVAS_DATA_ROOT; else process.env.CANVAS_DATA_ROOT = previousData;
  }
}
void main().catch(error => { console.error('Native session reader fixture failed at:', stage,
  (error as { code?: string })?.code ?? (error as Error).name); process.exitCode = 1; });
