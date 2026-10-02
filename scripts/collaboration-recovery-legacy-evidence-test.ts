import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { decodeHistoricalCollaborationIdentity, exportHistoricalCollaborationIdentities } from '../app/lib/collaboration/recovery-legacy-evidence';

type Row = Record<string, unknown>;
type FixtureDatabase = {
  exec(sql: string): void;
  prepare(sql: string): { run(...values: unknown[]): void };
  close(): void;
};
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as new (filename: string) => FixtureDatabase;
const hash = (filename: string) => createHash('sha256').update(readFileSync(filename)).digest('hex');
const contentHash = createHash('sha256').update('Original private text').digest('hex');
const common = { organization_id: 'organization', customer_id: null, project_id: null, workspace_id: 'workspace',
  workspace_type: 'team', path: 'note.txt', created_at: BigInt(1700000000000) };
const document: Row = { ...common, id: 'historical-document', lineage_id: 'historical-lineage', provider: 'yjs',
  state_version: BigInt(7), snapshot_revision_id: 'historical-revision', status: 'active', updated_at: BigInt(1700000001000) };
const revision: Row = { ...common, id: 'historical-revision', lineage_id: 'historical-lineage', revision_number: BigInt(4),
  content_hash: contentHash, size_bytes: BigInt(21), created_by_user_id: 'owner', created_by_actor_type: 'user',
  source_session_id: null, base_revision_id: null };
const lineage: Row = { ...common, id: 'historical-lineage', status: 'active', archived_at: null, trash_entry_id: null };

function fixture(change?: (database: FixtureDatabase) => void) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'canvas-legacy-evidence-'));
  const sqlitePath = path.join(directory, 'evidence.sqlite');
  const database = new Database(sqlitePath);
  try {
    // Exact historical columns confirmed in schema.ts/migrate.ts before removal
    // of SQLite. Missing migration-era fields are not synthesized by the reader.
    database.exec(`CREATE TABLE collaboration_documents (id TEXT, organization_id TEXT, customer_id TEXT, project_id TEXT,
      workspace_id TEXT, workspace_type TEXT, path TEXT, lineage_id TEXT, provider TEXT, state_version INTEGER,
      snapshot_revision_id TEXT, status TEXT, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE file_revisions (id TEXT, organization_id TEXT, customer_id TEXT, project_id TEXT, workspace_id TEXT,
        workspace_type TEXT, path TEXT, content_hash TEXT, size_bytes INTEGER, created_by_user_id TEXT,
        created_by_actor_type TEXT, source_session_id TEXT, base_revision_id TEXT, lineage_id TEXT,
        revision_number INTEGER, created_at INTEGER);
      CREATE TABLE file_collaboration_lineages (id TEXT, organization_id TEXT, customer_id TEXT, project_id TEXT,
        workspace_id TEXT, workspace_type TEXT, path TEXT, status TEXT, created_at INTEGER, archived_at INTEGER, trash_entry_id TEXT);
      CREATE TABLE unrequested_private_data (value TEXT);
      INSERT INTO unrequested_private_data VALUES ('Unrequested private secret');`);
    for (const [table, row] of [['collaboration_documents', document], ['file_revisions', revision],
      ['file_collaboration_lineages', lineage]] as const) {
      const entries = Object.entries(row);
      database.prepare(`INSERT INTO ${table} (${entries.map(([key]) => key).join(',')})
        VALUES (${entries.map(() => '?').join(',')})`).run(...entries.map(([, value]) => value));
    }
    change?.(database);
  } catch (error) { database.close(); rmSync(directory, { recursive: true, force: true }); throw error; }
  database.close();
  chmodSync(sqlitePath, 0o444); chmodSync(directory, 0o555);
  const beforeHash = hash(sqlitePath); const beforeStat = statSync(sqlitePath); const beforeFiles = readdirSync(directory);
  const close = () => {
    assert.equal(hash(sqlitePath), beforeHash, 'read-only export cannot change any source bytes');
    assert.equal(statSync(sqlitePath).mtimeMs, beforeStat.mtimeMs);
    assert.equal(statSync(sqlitePath).mode, beforeStat.mode);
    assert.deepEqual(readdirSync(directory), beforeFiles, 'read-only export creates no journal or WAL sidecars');
    chmodSync(directory, 0o700); chmodSync(sqlitePath, 0o600); rmSync(directory, { recursive: true, force: true });
  };
  return { sqlitePath, directory, close };
}

test('read-only SQLite export preserves exact requested identities, timestamps and the complete source', () => {
  const f = fixture(database => database.exec(`INSERT INTO collaboration_documents SELECT 'unrequested-document', organization_id,
    customer_id, project_id, workspace_id, workspace_type, 'other.txt', lineage_id, provider, state_version,
    snapshot_revision_id, status, created_at, updated_at FROM collaboration_documents`));
  try {
    const result = exportHistoricalCollaborationIdentities(f.sqlitePath, ['historical-document']);
    assert.equal(result.length, 1); const identity = result[0];
    assert.equal(identity.document.id, 'historical-document');
    assert.equal(identity.revision.id, 'historical-revision');
    assert.equal(identity.lineage?.id, 'historical-lineage');
    assert.equal(identity.document.createdAt, 1700000000000, 'timestamps are copied without inferred unit conversion');
    assert.equal(identity.revision.revisionNumber, 4); assert.equal(identity.revision.historyOnly, false);
    assert.equal(identity.revision.contentHash, contentHash);
    assert.deepEqual(exportHistoricalCollaborationIdentities(f.sqlitePath, ['historical-document']), result);
    assert(!JSON.stringify(result).includes('Unrequested private secret'));
    assert(!JSON.stringify(result).includes('unrequested-document'));
  } finally { f.close(); }
});

test('explicit null lineage is retained without generating or looking up a path identity', () => {
  const f = fixture(database => database.exec('UPDATE collaboration_documents SET lineage_id = NULL; UPDATE file_revisions SET lineage_id = NULL'));
  try {
    const [identity] = exportHistoricalCollaborationIdentities(f.sqlitePath, ['historical-document']);
    assert.equal(identity.document.lineageId, null); assert.equal(identity.revision.lineageId, null);
    assert.equal(identity.lineage, undefined, 'an unrelated same-path lineage is never substituted');
  } finally { f.close(); }
});

const invalidFixtures: Array<[string, (database: FixtureDatabase) => void]> = [
  ['missing document', database => database.exec('DELETE FROM collaboration_documents')],
  ['ambiguous document ID', database => database.exec('INSERT INTO collaboration_documents SELECT * FROM collaboration_documents')],
  ['missing snapshot revision', database => database.exec('DELETE FROM file_revisions')],
  ['ambiguous snapshot revision', database => database.exec('INSERT INTO file_revisions SELECT * FROM file_revisions')],
  ['missing lineage', database => database.exec('DELETE FROM file_collaboration_lineages')],
  ['ambiguous lineage', database => database.exec('INSERT INTO file_collaboration_lineages SELECT * FROM file_collaboration_lineages')],
  ['foreign revision scope', database => database.exec("UPDATE file_revisions SET workspace_id = 'foreign'")],
  ['foreign lineage scope', database => database.exec("UPDATE file_collaboration_lineages SET organization_id = 'foreign'")],
  ['wrong revision lineage', database => database.exec("UPDATE file_revisions SET lineage_id = 'foreign'")],
  ['missing actual lineage table', database => database.exec('ALTER TABLE file_collaboration_lineages RENAME TO collaboration_lineages')],
  ['view instead of historical table', database => database.exec(`ALTER TABLE file_revisions RENAME TO unrelated_revisions;
    CREATE VIEW file_revisions AS SELECT * FROM unrelated_revisions`)],
  ['missing migration-era lineage_id', database => database.exec('ALTER TABLE collaboration_documents DROP COLUMN lineage_id')],
  ['missing migration-era revision_number', database => database.exec('ALTER TABLE file_revisions DROP COLUMN revision_number')],
  ['unsafe integer', database => database.exec('UPDATE collaboration_documents SET state_version = 9007199254740993')],
  ['fractional integer', database => database.exec('UPDATE file_revisions SET size_bytes = 1.5')],
  ['invalid status', database => database.exec("UPDATE collaboration_documents SET status = 'recovery'")],
  ['invalid actor', database => database.exec("UPDATE file_revisions SET created_by_actor_type = 'owner'")],
  ['null snapshot binding', database => database.exec('UPDATE collaboration_documents SET snapshot_revision_id = NULL')],
  ['noncanonical path', database => database.exec("UPDATE collaboration_documents SET path = './note.txt'")],
  ['active archived lineage', database => database.exec('UPDATE file_collaboration_lineages SET archived_at = 1700000001000')],
  ['history-only revision', database => database.exec('ALTER TABLE file_revisions ADD COLUMN history_only INTEGER; UPDATE file_revisions SET history_only = 1')],
  ['invalid raw flag', database => database.exec("ALTER TABLE file_revisions ADD COLUMN history_only TEXT; UPDATE file_revisions SET history_only = '0'")],
];
for (const [name, change] of invalidFixtures) {
  test(`read-only SQLite export rejects ${name} without changing evidence`, () => {
    const f = fixture(change);
    try { assert.throws(() => exportHistoricalCollaborationIdentities(f.sqlitePath, ['historical-document'])); }
    finally { f.close(); }
  });
}

test('invalid or repeated requested IDs cannot select paths or substitute another identity', () => {
  const f = fixture();
  try {
    for (const ids of [['historical-document', 'historical-document'], [''], ['historical-document\0'], ['note.txt'],
      Array.from({ length: 10_001 }, (_, index) => `document-${index}`)])
      assert.throws(() => exportHistoricalCollaborationIdentities(f.sqlitePath, ids));
    assert.deepEqual(exportHistoricalCollaborationIdentities(f.sqlitePath, []), []);
  } finally { f.close(); }
});

test('an absent SQLite evidence file is never created', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'canvas-legacy-missing-'));
  const filename = path.join(directory, 'missing.sqlite');
  try { assert.throws(() => exportHistoricalCollaborationIdentities(filename, ['historical-document'])); assert.equal(existsSync(filename), false); }
  finally { rmSync(directory, { recursive: true, force: true }); }
});

test('decoder rejects unsafe coercion and keeps valid historical archives descriptive only', () => {
  for (const bad of [undefined, null, '7', 1.5, -1, Number.MAX_SAFE_INTEGER + 1, BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1)])
    assert.throws(() => decodeHistoricalCollaborationIdentity({ ...document, state_version: bad }, revision, lineage));
  const identity = decodeHistoricalCollaborationIdentity({ ...document, status: 'archived' }, revision,
    { ...lineage, status: 'archived', archived_at: BigInt(1700000001000), trash_entry_id: 'trash' });
  assert.equal(identity.document.status, 'archived'); assert.equal(identity.lineage?.status, 'archived');
});

test('total selected records are capped at 10000 including revisions and lineages', () => {
  const ids: string[] = [];
  const f = fixture(database => {
    database.exec('BEGIN');
    const tables = [['collaboration_documents', document], ['file_revisions', revision], ['file_collaboration_lineages', lineage]] as const;
    const statements = tables.map(([table, row]) => {
      const keys = Object.keys(row);
      return { keys, row, statement: database.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`) };
    });
    for (let index = 0; index < 3334; index++) {
      const documentId = `document-${index}`; const revisionId = `revision-${index}`; const lineageId = `lineage-${index}`;
      ids.push(documentId);
      statements.forEach(({ keys, row, statement }, role) => {
        const selected = { ...row, id: [documentId, revisionId, lineageId][role], path: `${index}.txt`,
          ...(role < 2 ? { lineage_id: lineageId } : {}), ...(role === 0 ? { snapshot_revision_id: revisionId } : {}) };
        statement.run(...keys.map((key) => selected[key as keyof typeof selected]));
      });
    }
    database.exec('COMMIT');
  });
  try { assert.throws(() => exportHistoricalCollaborationIdentities(f.sqlitePath, ids), /historical_record_limit/u); }
  finally { f.close(); }
});

test('WAL sidecars are rejected instead of treating a writer database as independent evidence', () => {
  const f = fixture(); const wal = f.sqlitePath + '-wal';
  try {
    chmodSync(f.directory, 0o700); writeFileSync(wal, 'Fixture sidecar'); chmodSync(f.directory, 0o555);
    assert.throws(() => exportHistoricalCollaborationIdentities(f.sqlitePath, ['historical-document']), /evidence_snapshot_has_sidecars/u);
  } finally { chmodSync(f.directory, 0o700); rmSync(wal, { force: true }); f.close(); }
});
