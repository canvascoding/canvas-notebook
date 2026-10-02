import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import * as Y from 'yjs';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { createPiTestDatabase } from './helpers/pi-test-database';
import { importHistoricalCollaborationIdentity, type HistoricalCollaborationIdentityImport } from '../app/lib/collaboration/recovery-identity-import';
import { recoveryHash } from '../app/lib/collaboration/recovery-plan';
import { decodeRecoveryState } from '../app/lib/collaboration/recovery-evidence';

let databasePromise: ReturnType<typeof createPiTestDatabase> | undefined;
after(async () => { if (databasePromise) await (await databasePromise).close(); });

async function fixture(withLineage = true) {
  const database = await (databasePromise ??= createPiTestDatabase()); const raw = await database.openDb();
  // Cases run serially and reset only this in-memory database. Migrate once:
  // this preserves full PostgreSQL constraints without repeated engine startup.
  for (const table of ['workspace_trash_entries', 'collaboration_file_projections', 'collaboration_documents', 'file_revisions',
    'file_collaboration_lineages', 'collaboration_yjs_states', 'canvas_workspaces', 'canvas_organization_settings', '"user"'])
    await raw.run(`DELETE FROM ${table}`);
  // Real pg returns int8 as decimal strings. Exercise that boundary even though
  // the isolated PostgreSQL-compatible test engine returns safe numeric values.
  const int8 = new Set(['created_at', 'updated_at', 'revision_number', 'state_version', 'size_bytes',
    'lifecycle_generation', 'schema_version', 'document_sequence', 'checkpoint_sequence', 'persisted_at',
    'checkpointed_at', 'has_bom', 'degraded', 'projection_error_permanent']);
  const row = (value: unknown) => value && Object.fromEntries(Object.entries(value).map(([key, value]) =>
    [key, value !== null && int8.has(key) ? String(value) : value]));
  const connection: SqlConnection = { ...raw,
    get: async (sql, params) => row(await raw.get(sql, params)),
    all: async (sql, params) => (await raw.all(sql, params)).map(row) as unknown[],
  };
  const workspace: WorkspaceContext = { workspaceId: 'workspace', organizationId: 'organization', workspaceType: 'team',
    rootPath: '/test-only/workspace', rootRelativePath: 'workspace/import-test', status: 'active', legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false,
      canManageWorkspace: true, canRunAgent: false } };
  const text = '\uFEFFOriginal private text\r\n'; const file = Buffer.from(text);
  const doc = new Y.Doc(); doc.getText('content').insert(0, 'Original private text\n');
  try {
    await raw.run(`INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at)
      VALUES ('owner','Owner','identity-import@example.test',0,1,1)`);
    await raw.run(`INSERT INTO canvas_organization_settings (organization_id,owner_user_id,created_at,updated_at)
      VALUES ('organization','owner',1,1)`);
    await raw.run(`INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at)
      VALUES ('workspace','organization','team','workspace/import-test','Recovery import','active',1,1)`);
    await raw.run(`INSERT INTO collaboration_yjs_states (document_id,workspace_id,organization_id,path,representation,
      lifecycle_generation,schema_version,yjs_state,state_vector,document_sequence,persisted_at,checkpointed_at,
      checkpoint_sequence,canonical_hash,serialized_hash,newline_style,has_bom,degraded,status)
      VALUES ('historical-document','workspace','organization','note.txt','plain_text',3,1,$1,$2,7,2,2,7,$3,$4,'crlf',1,0,'active')`,
    [Y.encodeStateAsUpdate(doc), Y.encodeStateVector(doc), recoveryHash('Original private text\n'), recoveryHash(file)]);
    const expectedState = decodeRecoveryState(await connection.get('SELECT * FROM collaboration_yjs_states') as Record<string, unknown>);
    const shared = { workspaceId: 'workspace', organizationId: 'organization', customerId: null, projectId: null,
      workspaceType: 'team' as const, path: 'note.txt', createdAt: 1 };
    const input: HistoricalCollaborationIdentityImport = { operation: 'import_historical_identity', workspace, expectedState,
      expectedFileHash: recoveryHash(file), readCurrentFile: async () => Uint8Array.from(file),
      document: { ...shared, id: 'historical-document', lineageId: withLineage ? 'historical-lineage' : null,
        provider: 'yjs', stateVersion: 7, snapshotRevisionId: 'historical-revision', status: 'active', updatedAt: 2 },
      revision: { ...shared, id: 'historical-revision', lineageId: withLineage ? 'historical-lineage' : null,
        revisionNumber: 4, contentHash: recoveryHash(file), sizeBytes: file.byteLength,
        createdByUserId: 'owner', createdByActorType: 'user', sourceSessionId: null, baseRevisionId: null, historyOnly: false },
      ...(withLineage ? { lineage: { ...shared, id: 'historical-lineage', status: 'active' as const, archivedAt: null, trashEntryId: null } } : {}),
    };
    const original = await raw.get('SELECT * FROM collaboration_yjs_states');
    const transact = async (input: HistoricalCollaborationIdentityImport, selectedConnection = connection) => {
      await raw.run('BEGIN');
      try { const result = await importHistoricalCollaborationIdentity(selectedConnection, input); await raw.run('COMMIT'); return result; }
      catch (error) { await raw.run('ROLLBACK'); throw error; }
    };
    return { database, raw, connection, input, original, file, transact, close: async () => { doc.destroy(); } };
  } catch (error) { doc.destroy(); throw error; }
}

for (const withLineage of [true, false]) {
  test(`historical identity import is exact, immutable and idempotent (${withLineage ? 'with' : 'without'} lineage)`, async () => {
    const f = await fixture(withLineage);
    try {
      assert.equal((await f.transact(f.input)).status, 'imported');
      const imported = await f.raw.get('SELECT * FROM collaboration_documents') as Record<string, unknown>;
      assert.equal(imported.id, 'historical-document');
      assert.equal(imported.yjs_state_lifecycle, 'initialized', 'an imported authoritative state never permits filesystem fallback');
      assert.equal((await f.transact(f.input)).status, 'already_imported');
      for (const table of ['collaboration_documents', 'file_revisions'])
        assert.equal((await f.raw.all(`SELECT * FROM ${table}`)).length, 1);
      assert.equal((await f.raw.all('SELECT * FROM file_collaboration_lineages')).length, withLineage ? 1 : 0);
      assert.deepEqual(await f.raw.get('SELECT * FROM collaboration_yjs_states'), f.original,
        'import cannot change original update, vector, checkpoint, generation, encoding or quarantine');
    } finally { await f.close(); }
  });
}

const invalidCases: Array<[string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<HistoricalCollaborationIdentityImport>]> = [
  ['explicit operation', async (f) => ({ ...f.input, operation: 'automatic_fallback' as never })],
  ['historical scope', async (f) => ({ ...f.input, revision: { ...f.input.revision, organizationId: 'foreign' } })],
  ['historical state version', async (f) => ({ ...f.input, document: { ...f.input.document, stateVersion: 6 } })],
  ['historical hash', async (f) => ({ ...f.input, revision: { ...f.input.revision, contentHash: '0'.repeat(64) } })],
  ['unverified revision parent', async (f) => ({ ...f.input, revision: { ...f.input.revision, baseRevisionId: 'missing' } })],
  ['historical archived row', async (f) => ({ ...f.input, document: { ...f.input.document, status: 'archived' } })],
  ['noncanonical path', async (f) => ({ ...f.input, expectedState: { ...f.input.expectedState, path: './note.txt' } })],
  ['changed current file', async (f) => ({ ...f.input, readCurrentFile: async () => Buffer.from('Changed outside known checkpoints') })],
  ['workspace root', async (f) => { await f.raw.run("UPDATE canvas_workspaces SET root_relative_path = 'moved-root'"); return f.input; }],
  ['workspace scope', async (f) => { await f.raw.run("UPDATE canvas_workspaces SET type = 'organization'"); return f.input; }],
  ['workspace status', async (f) => { await f.raw.run("UPDATE canvas_workspaces SET status = 'archived'"); return f.input; }],
  ['current binary', async (f) => { await f.raw.run('UPDATE collaboration_yjs_states SET yjs_state = $1', [new Uint8Array([0, 0])]); return f.input; }],
  ['current sequence', async (f) => { await f.raw.run('UPDATE collaboration_yjs_states SET document_sequence = 8'); return f.input; }],
  ['current generation', async (f) => { await f.raw.run('UPDATE collaboration_yjs_states SET lifecycle_generation = 4'); return f.input; }],
  ['current quarantine', async (f) => { await f.raw.run('UPDATE collaboration_yjs_states SET degraded = 1'); return f.input; }],
  ['current encoding', async (f) => { await f.raw.run('UPDATE collaboration_yjs_states SET has_bom = 0'); return f.input; }],
  ['current path status', async (f) => { await f.raw.run("UPDATE collaboration_yjs_states SET status = 'archived'"); return f.input; }],
  ['existing successor', async (f) => {
    await f.raw.run(`INSERT INTO collaboration_documents (id,workspace_id,organization_id,workspace_type,path,provider,status,created_at,updated_at)
      VALUES ('successor','workspace','organization','team','note.txt','yjs','active',1,1)`); return f.input;
  }],
  ['existing archived registry', async (f) => {
    await f.raw.run(`INSERT INTO collaboration_documents (id,workspace_id,organization_id,workspace_type,path,provider,status,created_at,updated_at)
      VALUES ('historical-document','workspace','organization','team','note.txt','yjs','archived',1,1)`); return f.input;
  }],
  ['existing archived lineage', async (f) => {
    await f.raw.run(`INSERT INTO file_collaboration_lineages (id,workspace_id,organization_id,workspace_type,path,status,created_at,archived_at)
      VALUES ('historical-lineage','workspace','organization','team','note.txt','archived',1,2)`); return f.input;
  }],
  ['existing foreign revision', async (f) => {
    await f.raw.run(`INSERT INTO file_revisions (id,workspace_id,organization_id,workspace_type,path,content_hash,size_bytes,created_by_actor_type,revision_number,created_at)
      VALUES ('historical-revision','foreign-workspace','organization','team','note.txt',$1,1,'user',1,1)`, [f.input.expectedFileHash]); return f.input;
  }],
  ['deleted parent directory', async (f) => {
    await f.raw.run("UPDATE collaboration_yjs_states SET path = 'folder/note.txt'");
    await f.raw.run(`INSERT INTO workspace_trash_entries (id,workspace_id,workspace_type,original_path,trash_relative_path,entry_name,item_type,status,deleted_at,expires_at)
      VALUES ('trash','workspace','team','folder','trash/folder','folder','directory','trashed',1,2)`);
    return { ...f.input, expectedState: { ...f.input.expectedState, path: 'folder/note.txt' },
      document: { ...f.input.document, path: 'folder/note.txt' }, revision: { ...f.input.revision, path: 'folder/note.txt' },
      lineage: { ...f.input.lineage!, path: 'folder/note.txt' } };
  }],
  ['conflicting projection receipt', async (f) => {
    await f.raw.run(`INSERT INTO collaboration_file_projections
      (document_id,lifecycle_generation,projected_sequence,revision_id,canonical_hash,serialized_hash,finalized,updated_at)
      VALUES ('historical-document',3,6,'foreign-revision',$1,$2,0,1)`,
    [f.input.expectedState.canonicalHash, f.input.expectedFileHash]); return f.input;
  }],
];

for (const [name, prepare] of invalidCases) {
  test(`historical identity import rejects ${name} without partial metadata`, async () => {
    const f = await fixture();
    try {
      const input = await prepare(f);
      const before = await Promise.all(['collaboration_documents', 'file_revisions', 'file_collaboration_lineages', 'collaboration_yjs_states', 'collaboration_file_projections']
        .map((table) => f.raw.all(`SELECT * FROM ${table} ORDER BY 1`)));
      await assert.rejects(f.transact(input));
      const after = await Promise.all(['collaboration_documents', 'file_revisions', 'file_collaboration_lineages', 'collaboration_yjs_states', 'collaboration_file_projections']
        .map((table) => f.raw.all(`SELECT * FROM ${table} ORDER BY 1`)));
      assert.deepEqual(after, before, 'rejection preserves current successor, archives, metadata and original binary');
    } finally { await f.close(); }
  });
}

test('a changed imported revision is a conflict rather than an idempotent success', async () => {
  const f = await fixture();
  try {
    await f.transact(f.input);
    await f.raw.run('UPDATE file_revisions SET content_hash = $1', ['0'.repeat(64)]);
    await assert.rejects(f.transact(f.input), /existing_revision_conflict/u);
    assert.deepEqual(await f.raw.get('SELECT * FROM collaboration_yjs_states'), f.original);
  } finally { await f.close(); }
});

test('an existing scoped base revision is retained without rebinding its history', async () => {
  const f = await fixture();
  try {
    await f.raw.run(`INSERT INTO file_revisions (id,workspace_id,organization_id,workspace_type,path,lineage_id,content_hash,
      size_bytes,created_by_actor_type,revision_number,created_at)
      VALUES ('base','workspace','organization','team','note.txt','historical-lineage',$1,1,'user',3,1)`, [recoveryHash('base')]);
    const before = await f.raw.get("SELECT * FROM file_revisions WHERE id = 'base'");
    const input = { ...f.input, revision: { ...f.input.revision, baseRevisionId: 'base' } };
    assert.equal((await f.transact(input)).status, 'imported');
    assert.equal((await f.transact(input)).status, 'already_imported');
    assert.deepEqual(await f.raw.get("SELECT * FROM file_revisions WHERE id = 'base'"), before);
    assert.deepEqual(await f.raw.get('SELECT * FROM collaboration_yjs_states'), f.original);
  } finally { await f.close(); }
});

test('a late insert failure rolls back partial imports even if the caller continues its transaction', async () => {
  const f = await fixture();
  try {
    const failingConnection: SqlConnection = { ...f.connection,
      run: async (sql, params) => {
        if (sql.startsWith('INSERT INTO file_revisions')) throw new Error('Controlled insert failure');
        return f.connection.run(sql, params);
      },
    };
    await f.raw.run('BEGIN');
    await assert.rejects(importHistoricalCollaborationIdentity(failingConnection, f.input), /Controlled insert failure/u);
    for (const table of ['collaboration_documents', 'file_revisions', 'file_collaboration_lineages'])
      assert.deepEqual(await f.raw.all(`SELECT * FROM ${table}`), []);
    await f.raw.run('COMMIT');
    assert.deepEqual(await f.raw.get('SELECT * FROM collaboration_yjs_states'), f.original);
  } finally { await f.close(); }
});

test('a matching checkpoint receipt remains byte-for-byte unchanged during import and rerun', async () => {
  const f = await fixture();
  try {
    await f.raw.run(`INSERT INTO collaboration_file_projections
      (document_id,lifecycle_generation,projected_sequence,revision_id,canonical_hash,serialized_hash,finalized,updated_at)
      VALUES ('historical-document',3,7,'historical-revision',$1,$2,1,2)`,
    [f.input.expectedState.canonicalHash, f.input.expectedFileHash]);
    const receipt = await f.raw.get('SELECT * FROM collaboration_file_projections');
    assert.equal((await f.transact(f.input)).status, 'imported');
    assert.equal((await f.transact(f.input)).status, 'already_imported');
    assert.deepEqual(await f.raw.get('SELECT * FROM collaboration_file_projections'), receipt);
    assert.deepEqual(await f.raw.get('SELECT * FROM collaboration_yjs_states'), f.original);
  } finally { await f.close(); }
});
